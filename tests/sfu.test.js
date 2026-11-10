const { expect } = require('expect');
const { Users } = require('../server/utils/users');
const { SfuService } = require('../server/services/sfu.service');
const { registerSfuHandlers } = require('../server/sockets/sfu.handler');

class MockEvent {
  constructor() {
    this.listeners = [];
  }

  subscribe(fn) {
    this.listeners.push(fn);
    return {
      unSubscribe: () => {
        this.listeners = this.listeners.filter((l) => l !== fn);
      },
    };
  }

  execute(...args) {
    this.listeners.forEach((fn) => fn(...args));
  }
}

class MockPeerConnection {
  constructor() {
    this.onIceCandidate = new MockEvent();
    this.onTrack = new MockEvent();
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedTracks = [];
    this.removedSenders = [];
    this.candidates = [];
    this.closed = false;
    this.offerCounter = 0;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\na=mock-answer\r\n' };
  }

  async createOffer() {
    this.offerCounter += 1;
    return { type: 'offer', sdp: `v=0\r\na=mock-sfu-offer-${this.offerCounter}\r\n` };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
  }

  addTrack(track, stream) {
    const sender = { track, stream };
    this.addedTracks.push(sender);
    return sender;
  }

  removeTrack(sender) {
    this.removedSenders.push(sender);
  }

  async close() {
    this.closed = true;
  }

  simulateIncomingTrack(kind = 'video') {
    const fakeRemoteTrack = {
      kind,
      onReceiveRtp: new MockEvent(),
    };
    this.onTrack.execute(fakeRemoteTrack);
    return fakeRemoteTrack;
  }
}

describe('WebRTC SFU Service & Socket Handlers (1-to-1 & Multi-User Room Calls)', () => {
  let users;
  let emitted;
  let io;
  let sfuService;

  const createSocket = (id, name, room) => {
    users.addUser(id, name, room);
    const handlers = {};
    const socket = {
      id,
      on(event, fn) {
        handlers[event] = fn;
      },
      trigger(event, ...args) {
        if (handlers[event]) {
          return handlers[event](...args);
        }
        return undefined;
      },
    };
    registerSfuHandlers(io, socket, users, sfuService);
    return socket;
  };

  beforeEach(() => {
    users = new Users();
    emitted = [];
    io = {
      to(target) {
        return {
          emit(event, data) {
            emitted.push({ target, event, data });
          },
        };
      },
    };
    sfuService = new SfuService(io, users, MockPeerConnection);
  });

  it('should allow multiple users to join a room SFU session and forward RTP tracks across participants', async () => {
    const socketA = createSocket('user-a', 'Ashik', 'Engineering');
    const socketB = createSocket('user-b', 'Jen', 'Engineering');
    const sessionId = 'room:Engineering';

    // User A joins room SFU call
    const joinResA = await new Promise((resolve) => {
      socketA.trigger(
        'sfu:join',
        {
          sessionId,
          mode: 'video',
          sdp: { type: 'offer', sdp: 'v=0\r\na=offer-a\r\n' },
        },
        resolve
      );
    });

    expect(joinResA.ok).toBe(true);
    expect(joinResA.sdp.type).toBe('answer');
    expect(joinResA.participants.length).toBe(1);

    // User A publishes a video track
    const session = sfuService.sessions.get(sessionId);
    const peerA = session.get('user-a');
    const remoteTrackA = peerA.pc.simulateIncomingTrack('video');

    // User B joins the same room SFU call
    const joinResB = await new Promise((resolve) => {
      socketB.trigger(
        'sfu:join',
        {
          sessionId,
          mode: 'video',
          sdp: { type: 'offer', sdp: 'v=0\r\na=offer-b\r\n' },
        },
        resolve
      );
    });

    expect(joinResB.ok).toBe(true);
    expect(joinResB.participants.length).toBe(2);

    // Wait for renegotiation promise chain
    const peerB = session.get('user-b');
    await peerB.negotiationChain;

    // Verify User A's published video track was attached and renegotiated to User B
    expect(peerB.pc.addedTracks.length).toBe(1);
    expect(peerB.pc.addedTracks[0].track.kind).toBe('video');
    expect(emitted.some((e) => e.target === 'user-b' && e.event === 'sfu:offer')).toBe(true);

    // Verify User B can send an answer and ICE candidate to the SFU
    await socketB.trigger('sfu:answer', {
      sessionId,
      sdp: { type: 'answer', sdp: 'v=0\r\na=answer-b\r\n' },
    });
    expect(peerB.pc.remoteDescription.sdp).toContain('answer-b');

    await socketB.trigger('sfu:candidate', {
      sessionId,
      candidate: { candidate: 'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host' },
    });
    expect(peerB.pc.candidates.length).toBe(1);

    // Simulate RTP packet from User A and ensure it forwards without error
    const forwardedTrack = peerB.pc.addedTracks[0].track;
    let rtpForwarded = false;
    forwardedTrack.writeRtp = () => {
      rtpForwarded = true;
    };
    remoteTrackA.onReceiveRtp.execute({ clone: () => ({ header: {} }) });
    expect(rtpForwarded).toBe(true);
  });

  it('should support 1-to-1 private SFU calls, media state toggling, and clean participant departure', async () => {
    const socketA = createSocket('user-a', 'Ashik', 'Engineering');
    const socketB = createSocket('user-b', 'Jen', 'Engineering');
    const privateSessionId = 'private:user-a:user-b';

    await new Promise((resolve) => {
      socketA.trigger(
        'sfu:join',
        {
          sessionId: privateSessionId,
          mode: 'audio',
          sdp: { type: 'offer', sdp: 'v=0\r\na=private-offer-a\r\n' },
        },
        resolve
      );
    });

    await new Promise((resolve) => {
      socketB.trigger(
        'sfu:join',
        {
          sessionId: privateSessionId,
          mode: 'audio',
          sdp: { type: 'offer', sdp: 'v=0\r\na=private-offer-b\r\n' },
        },
        resolve
      );
    });

    expect(sfuService.getSessionParticipants(privateSessionId).length).toBe(2);

    // Toggle microphone state
    socketA.trigger('sfu:media-state', {
      sessionId: privateSessionId,
      audioEnabled: false,
    });
    const mediaStateEvent = emitted.find(
      (e) => e.target === 'user-b' && e.event === 'sfu:media-state'
    );
    expect(mediaStateEvent).toBeDefined();
    expect(mediaStateEvent.data.audioEnabled).toBe(false);

    // Leave session
    await new Promise((resolve) => {
      socketA.trigger('sfu:leave', { sessionId: privateSessionId }, resolve);
    });

    expect(sfuService.getSessionParticipants(privateSessionId).length).toBe(1);
    expect(
      emitted.some((e) => e.target === 'user-b' && e.event === 'sfu:participant-left')
    ).toBe(true);
  });
});
