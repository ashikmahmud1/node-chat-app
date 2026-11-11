const assert = require('node:assert/strict');
const { SfuService } = require('../server/services/sfu.service');

class MockEvent {
  listeners = new Set();

  subscribe(listener) {
    this.listeners.add(listener);
    return { unSubscribe: () => this.listeners.delete(listener) };
  }

  emit(value) {
    for (const listener of this.listeners) listener(value);
  }
}

const bundledDescription = [
  'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'a=group:BUNDLE 0 1', 'm=audio 5000 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 192.0.2.10', 'a=mid:0', 'a=rtpmap:111 opus/48000/2',
  'a=candidate:1 1 udp 2130706431 192.0.2.10 5000 typ host',
  'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 VP8/90000', '',
].join('\r\n');

class MockPeer {
  connectionStateChange = new MockEvent();
  onTrack = new MockEvent();
  offers = 0;
  senders = [];

  async setRemoteDescription(description) {
    if (description.sdp === 'fail') throw new Error('Bad offer');
    this.remote = description;
  }

  async setLocalDescription(description) { this.localDescription = description; }
  async createAnswer() { return { type: 'answer', sdp: bundledDescription }; }
  async createOffer() {
    this.offers += 1;
    return { type: 'offer', sdp: bundledDescription };
  }
  async close() { this.closed = true; }
  getReceivers() { return []; }

  addTransceiver(track) {
    const sender = { track, onPictureLossIndication: new MockEvent() };
    this.senders.push(sender);
    return { sender, stop: () => { this.senders = this.senders.filter((item) => item !== sender); } };
  }

  publish(kind) {
    const track = { kind, onReceiveRtp: new MockEvent() };
    this.onTrack.emit(track);
    return track;
  }
}

describe('SFU negotiation and cleanup', () => {
  const sessionId = 'room:chat:engineering';
  let service;
  let emitted;

  beforeEach(() => {
    emitted = [];
    service = new SfuService({
      to: (target) => ({ emit: (event, data) => emitted.push({ target, event, data }) }),
    }, MockPeer);
  });

  afterEach(() => service.closeAllSessions());

  async function join(id, sdp = 'offer') {
    const { sdp: answer } = await service.joinSession({
      sessionId, socket: { id }, mode: 'video', sdp: { type: 'offer', sdp },
      user: { name: id, room: 'Engineering' },
    });
    assert.match(answer.sdp, /s=-\r\nc=IN IP4 0\.0\.0\.0\r\nt=0 0/);
    assert.match(answer.sdp, /m=audio[^\r]*\r\nc=IN IP4 192\.0\.2\.10/);
    return service.sessions.get(sessionId).get(id);
  }

  it('cleans up an unsuccessful join', async () => {
    await assert.rejects(join('alice', 'fail'), /Bad offer/);
    assert.equal(service.getActiveSessionCount(), 0);
    await join('alice');
    await assert.rejects(join('alice'), /Leave your current call/);
  });

  it('offers forwarded tracks after initial negotiation and waits for the matching answer', async () => {
    const alice = await join('alice');
    const bob = await join('bob');
    const video = alice.pc.publish('video');
    alice.pc.publish('audio');
    service.ready(sessionId, 'alice');
    assert.equal(bob.pc.senders.length, 0);
    service.ready(sessionId, 'bob');
    await new Promise(setImmediate);
    await bob.negotiationChain;
    assert.equal(bob.pc.senders.length, 2);
    assert.equal(bob.pc.offers, 1);

    alice.pc.publish('audio');
    await new Promise(setImmediate);
    assert.equal(bob.pc.offers, 1);
    await service.handleAnswer({ sessionId, socketId: 'bob', revision: 99, sdp: { type: 'answer', sdp: 'stale' } });
    assert.equal(bob.pc.remote.sdp, 'offer');

    const first = emitted.find((item) => item.event === 'sfu:offer' && item.target === 'bob');
    assert.match(first.data.sdp.sdp, /s=-\r\nc=IN IP4 0\.0\.0\.0\r\nt=0 0/);
    await service.handleAnswer({ sessionId, socketId: 'bob', revision: first.data.revision, sdp: { type: 'answer', sdp: 'valid' } });
    await bob.negotiationChain;
    assert.equal(bob.pc.offers, 2);

    const forwarded = { header: {} };
    let received;
    bob.pc.senders[0].track.writeRtp = (packet) => { received = packet; };
    video.onReceiveRtp.emit(forwarded);
    assert.equal(received, forwarded);
    await service.leaveSession(sessionId, 'alice');
    assert.equal(video.onReceiveRtp.listeners.size, 0);
    assert.equal(bob.pc.senders.length, 0);
    assert.equal(alice.pc.closed, true);
  });
});
