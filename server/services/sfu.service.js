const { RTCPeerConnection, MediaStreamTrack, MediaStream } = require('werift');
const config = require('../config');
const { logger } = require('../utils/logger');
const { reject } = require('../sockets/events');

function localDescriptionForBrowser({ type, sdp }) {
  // RFC 8866 requires connection information at session level or in every
  // media section. Bundled media can inherit it from the session.
  const session = sdp.split('\r\nm=', 1)[0];
  const description = /^c=/m.test(session) ? sdp : sdp.replace(/^t=/m, 'c=IN IP4 0.0.0.0\r\nt=');
  return { type, sdp: description };
}

class SfuService {
  constructor(io, PeerConnectionClass = RTCPeerConnection) {
    this.io = io;
    this.PeerConnectionClass = PeerConnectionClass;
    this.onPeerConnected = () => {};
    this.onPeerFailed = () => {};
    // Map<sessionId, Map<socketId, PeerSession>>
    this.sessions = new Map();
  }

  getActiveSessionCount() {
    return this.sessions.size;
  }

  getOrCreateSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map());
    }
    return this.sessions.get(sessionId);
  }

  getSessionParticipants(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.values()).map((peer) => ({
      socketId: peer.socketId,
      name: peer.name,
      room: peer.room,
      mode: peer.mode,
      streamId: peer.streamId,
      connected: peer.connected,
      audioEnabled: peer.audioEnabled,
      videoEnabled: peer.videoEnabled,
      screenSharing: peer.screenSharing,
    }));
  }

  hasPeer(socketId) {
    return Array.from(this.sessions.values()).some((session) => session.has(socketId));
  }

  async joinSession({ sessionId, socket, mode, sdp, user }) {
    if (this.hasPeer(socket.id)) reject('Leave your current call first.');
    const activePeers = Array.from(this.sessions.values()).reduce((total, session) => total + session.size, 0);
    if (activePeers >= config.limits.maxSfuPeers) reject('All media connections are in use. Try again shortly.');
    const session = this.getOrCreateSession(sessionId);
    if (session.size >= config.limits.maxCallParticipants) reject('This call is full.');
    const pc = new this.PeerConnectionClass({
      ...config.webrtc.peerOptions,
      iceServers: config.webrtc.getSfuIceServers(user.guestId),
    });

    const peerState = {
      sessionId,
      socketId: socket.id,
      name: user.name,
      room: user.room,
      mode,
      streamId: `sfu-peer-${socket.id}`,
      audioEnabled: true,
      videoEnabled: mode === 'video',
      screenSharing: false,
      pc,
      publishedTracks: [], // Array<{ remoteTrack, kind }>
      forwardedSubscriptions: new Map(),
      negotiationChain: Promise.resolve(),
      closed: false,
      ready: false,
      dirty: false,
      connected: false,
      revision: 0,
      pendingRevision: null,
    };

    session.set(socket.id, peerState);

    pc.connectionStateChange.subscribe((state) => {
      if (peerState.closed) return;
      peerState.connected = state === 'connected';
      if (peerState.connected) this.onPeerConnected(socket.id);
      if (state === 'failed') this.failPeer(peerState);
    });

    pc.onTrack.subscribe((remoteTrack) => {
      if (peerState.closed) return;
      peerState.publishedTracks.push({
        remoteTrack,
        kind: remoteTrack.kind,
      });

      if (!peerState.ready) return;
      for (const otherPeer of session.values()) {
        if (otherPeer !== peerState && otherPeer.ready) this.forwardTrackToSubscriber(peerState, remoteTrack, otherPeer);
      }
    });

    peerState.timeout = setTimeout(() => this.failPeer(peerState), 25000);
    peerState.timeout.unref();
    try {
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      if (peerState.closed) reject('This call ended.');
      if (!pc.localDescription.sdp.includes('a=candidate:')) {
        logger.warn('No local media candidates were gathered. Check the RTC UDP range and network configuration.');
        reject('The server could not open a media connection.');
      }
      this.broadcastParticipants(sessionId);
      return { sdp: localDescriptionForBrowser(pc.localDescription), participants: this.getSessionParticipants(sessionId) };
    } catch (error) {
      if (!peerState.closed) this.closePeer(sessionId, socket.id);
      throw error;
    }
  }

  ready(sessionId, socketId) {
    const session = this.sessions.get(sessionId);
    const peer = session?.get(socketId);
    if (!peer || peer.closed || peer.ready) return;
    clearTimeout(peer.timeout);
    peer.ready = true;
    for (const other of session.values()) {
      if (other === peer || !other.ready) continue;
      for (const { remoteTrack } of other.publishedTracks) this.forwardTrackToSubscriber(other, remoteTrack, peer);
      for (const { remoteTrack } of peer.publishedTracks) this.forwardTrackToSubscriber(peer, remoteTrack, other);
    }
  }

  failPeer(peer, error) {
    if (peer.closed) return;
    if (error) logger.warn('WebRTC negotiation failed', { error: error.name });
    this.io.to(peer.socketId).emit('sfu:failed', { sessionId: peer.sessionId });
    this.closePeer(peer.sessionId, peer.socketId);
    this.onPeerFailed(peer.socketId, peer.sessionId);
  }

  requestPublisherKeyframe(publisherPeer, remoteTrack) {
    if (!publisherPeer || publisherPeer.closed || !remoteTrack || !remoteTrack.ssrc) return;
    try {
      const receivers = publisherPeer.pc.getReceivers();
      for (const receiver of receivers) {
        if (receiver && typeof receiver.sendRtcpPLI === 'function') {
          receiver.sendRtcpPLI(remoteTrack.ssrc);
        }
      }
    } catch (error) {
      logger.debug('Could not request video keyframe', { error: error.name });
    }
  }

  forwardTrackToSubscriber(publisherPeer, remoteTrack, subscriberPeer) {
    if (publisherPeer.closed || subscriberPeer.closed) return;
    const existing = publisherPeer.forwardedSubscriptions.get(subscriberPeer.socketId);
    if (existing?.some((item) => item.remoteTrack === remoteTrack)) return;

    const forwardTrack = new MediaStreamTrack({
      kind: remoteTrack.kind,
      codec: remoteTrack.codec,
    });
    const outStream = new MediaStream({
      id: publisherPeer.streamId,
    });
    outStream.addTrack(forwardTrack);

    const { unSubscribe } = remoteTrack.onReceiveRtp.subscribe((rtp) => {
      if (!forwardTrack.stopped && !subscriberPeer.closed) {
        try {
          forwardTrack.writeRtp(rtp);
        } catch (error) {
          this.failPeer(subscriberPeer, error);
        }
      }
    });

    let transceiver;
    try {
      transceiver = subscriberPeer.pc.addTransceiver(forwardTrack, { direction: 'sendonly', streams: [outStream] });
      if (remoteTrack.kind === 'video') {
        transceiver.sender.onPictureLossIndication.subscribe(() => {
          this.requestPublisherKeyframe(publisherPeer, remoteTrack);
        });
      }
    } catch (error) {
      unSubscribe();
      forwardTrack.stop();
      this.failPeer(subscriberPeer, error);
      return;
    }

    // Request an initial keyframe so the new subscriber renders video immediately
    if (remoteTrack.kind === 'video') {
      this.requestPublisherKeyframe(publisherPeer, remoteTrack);
    }

    if (!publisherPeer.forwardedSubscriptions.has(subscriberPeer.socketId)) {
      publisherPeer.forwardedSubscriptions.set(subscriberPeer.socketId, []);
    }
    publisherPeer.forwardedSubscriptions.get(subscriberPeer.socketId).push({
      remoteTrack,
      unSubscribe,
      forwardTrack,
      transceiver,
    });

    this.scheduleRenegotiation(subscriberPeer);
  }

  scheduleRenegotiation(peer) {
    peer.dirty = true;
    queueMicrotask(() => this.negotiate(peer));
  }

  negotiate(peer) {
    if (peer.closed || !peer.ready || !peer.dirty || peer.pendingRevision !== null) return;
    peer.dirty = false;
    const revision = ++peer.revision;
    peer.pendingRevision = revision;
    peer.timeout = setTimeout(() => this.failPeer(peer), 25000);
    peer.timeout.unref();
    peer.negotiationChain = (async () => {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      if (peer.closed) return;
      const trackOwnerMap = Object.fromEntries(
        this.getSessionParticipants(peer.sessionId).map((participant) => [participant.streamId, participant])
      );
      this.io.to(peer.socketId).emit('sfu:offer', {
        sessionId: peer.sessionId,
        revision,
        sdp: localDescriptionForBrowser(peer.pc.localDescription),
        trackOwnerMap,
      });
    })().catch((error) => this.failPeer(peer, error));
  }

  async handleAnswer({ sessionId, socketId, revision, sdp }) {
    const peer = this.sessions.get(sessionId)?.get(socketId);
    if (!peer || peer.closed || peer.pendingRevision !== revision || peer.applyingAnswer) return;
    peer.applyingAnswer = true;
    try {
      await peer.negotiationChain;
      if (peer.closed) return;
      await peer.pc.setRemoteDescription(sdp);
      clearTimeout(peer.timeout);
      peer.pendingRevision = null;
      peer.applyingAnswer = false;
      this.negotiate(peer);
    } catch (error) {
      this.failPeer(peer, error);
    }
  }

  updateMediaState({ sessionId, socketId, audioEnabled, videoEnabled, screenSharing }) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const peer = session.get(socketId);
    if (!peer || peer.closed) return null;

    if (typeof audioEnabled === 'boolean') peer.audioEnabled = audioEnabled;
    if (typeof videoEnabled === 'boolean') peer.videoEnabled = videoEnabled;
    if (typeof screenSharing === 'boolean') peer.screenSharing = screenSharing;

    const payload = {
      sessionId,
      socketId,
      name: peer.name,
      streamId: peer.streamId,
      audioEnabled: peer.audioEnabled,
      videoEnabled: peer.videoEnabled,
      screenSharing: peer.screenSharing,
    };

    for (const otherSocketId of session.keys()) {
      this.io.to(otherSocketId).emit('sfu:media-state', payload);
    }

    return payload;
  }

  closePeer(sessionId, socketId) {
    this.leaveSession(sessionId, socketId).catch((error) =>
      logger.warn('Could not close media connection', { error: error.name })
    );
  }

  async leaveSession(sessionId, socketId, notify = true) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.has(socketId)) return false;

    const leavingPeer = session.get(socketId);
    leavingPeer.closed = true;
    clearTimeout(leavingPeer.timeout);
    session.delete(socketId);
    if (!session.size) this.sessions.delete(sessionId);

    for (const [targetSocketId, forwardList] of leavingPeer.forwardedSubscriptions.entries()) {
      const targetPeer = session.get(targetSocketId);
      for (const item of forwardList) {
        try {
          item.unSubscribe();
          item.forwardTrack.stop();
          if (targetPeer && !targetPeer.closed) item.transceiver.stop();
        } catch (err) {}
      }
      if (targetPeer && !targetPeer.closed) {
        this.scheduleRenegotiation(targetPeer);
      }
    }
    leavingPeer.forwardedSubscriptions.clear();

    for (const otherPeer of session.values()) {
      const subsToLeaving = otherPeer.forwardedSubscriptions.get(socketId);
      if (subsToLeaving) {
        for (const item of subsToLeaving) {
          try {
            item.unSubscribe();
            item.forwardTrack.stop();
          } catch (err) {}
        }
        otherPeer.forwardedSubscriptions.delete(socketId);
      }
    }

    if (notify) {
      for (const remainingSocketId of session.keys()) {
        this.io.to(remainingSocketId).emit('sfu:participant-left', {
          sessionId,
          socketId,
          streamId: leavingPeer.streamId,
        });
      }
      this.broadcastParticipants(sessionId);
    }

    await leavingPeer.pc.close();
    return true;
  }

  async leaveAllSessions(socketId) {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (session && session.has(socketId)) {
        await this.leaveSession(sessionId, socketId, true);
      }
    }
  }

  async closeAllSessions() {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      const peerIds = Array.from(session.keys());
      for (const socketId of peerIds) {
        await this.leaveSession(sessionId, socketId, false);
      }
    }
    this.sessions.clear();
  }

  broadcastParticipants(sessionId) {
    if (!sessionId.startsWith('room:')) return;
    this.io.to(sessionId.slice(5)).emit('sfu:room-call-status', {
      sessionId,
      participants: this.getSessionParticipants(sessionId),
    });
  }
}

module.exports = { SfuService };
