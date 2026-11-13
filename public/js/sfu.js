'use strict';

class SfuClient {
  constructor(socket, request) {
    this.request = request;
    this.current = null;
    socket.on('sfu:offer', (offer) => this.answer(offer));
    socket.on('sfu:failed', ({ sessionId }) => {
      if (this.current?.sessionId === sessionId) this.current.onError('The media connection failed.');
    });
  }

  async start(sessionId, mode, stream, { onTrack, onConnected, onError, onParticipants, roomCallId }) {
    const response = await fetch('/api/rtc-config', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Call configuration is unavailable.');
    const { iceServers, iceTransportPolicy } = await response.json();
    if (!stream.active) return null;
    // Offer each media kind with a transport so the SFU can accept it before
    // grouping the negotiated media onto a single BUNDLE transport.
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy, bundlePolicy: 'max-compat' });
    const state = { pc, sessionId, onError, onParticipants, connectionTimer: null };
    this.current = state;
    for (const track of stream.getTracks()) pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    const presentation = pc.addTransceiver('video', { direction: 'sendonly', streams: [new MediaStream()] });
    state.screenSender = presentation.sender;
    pc.ontrack = onTrack;
    const failed = () => {
      if (this.current === state) onError('The media connection timed out.');
    };
    state.connectionTimer = setTimeout(failed, 30000);
    pc.onconnectionstatechange = () => {
      if (this.current !== state) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(state.connectionTimer);
        onConnected?.();
      }
      if (pc.connectionState === 'disconnected') {
        clearTimeout(state.connectionTimer);
        state.connectionTimer = setTimeout(failed, 8000);
      }
      if (pc.connectionState === 'failed') failed();
    };
    await pc.setLocalDescription(await pc.createOffer());
    await this.gatherIce(pc);
    if (this.current !== state) return null;
    if (iceTransportPolicy === 'relay' && !/^a=candidate:[^\r\n]+ typ relay(?: |\r?$)/m.test(pc.localDescription.sdp)) {
      throw new Error('The browser could not reach the TURN relay.');
    }
    const result = await this.request('sfu:join', {
      sessionId, mode, roomCallId, screenMid: presentation.mid, sdp: pc.localDescription,
    }, 28000);
    if (this.current !== state) return null;
    onParticipants(result.participants);
    await pc.setRemoteDescription(result.sdp);
    if (this.current === state) await this.request('sfu:ready', { sessionId });
    return this.current === state ? state : null;
  }

  async answer({ sessionId, revision, sdp, participants }) {
    const state = this.current;
    if (state?.sessionId !== sessionId) return;
    const { pc } = state;
    try {
      state.onParticipants(participants);
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gatherIce(pc);
      if (this.current === state) await this.request('sfu:answer', { sessionId, revision, sdp: pc.localDescription }, 28000);
    } catch (error) {
      if (this.current === state) state.onError(error.message);
    }
  }

  gatherIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        pc.removeEventListener('signalingstatechange', check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (pc.signalingState === 'closed') finish(new Error('The call ended.'));
        else if (pc.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(() => finish(new Error('Unable to gather network candidates.')), 12000);
      pc.addEventListener('icegatheringstatechange', check);
      pc.addEventListener('signalingstatechange', check);
      check();
    });
  }

  close() {
    if (!this.current) return;
    const { pc, connectionTimer } = this.current;
    this.current = null;
    clearTimeout(connectionTimer);
    pc.close();
  }
}
