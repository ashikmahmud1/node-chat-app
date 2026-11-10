const { RTCPeerConnection, MediaStreamTrack, MediaStream } = require('werift');
const config = require('../config');

class SfuService {
  constructor(io, users, PeerConnectionClass = RTCPeerConnection) {
    this.io = io;
    this.users = users;
    this.PeerConnectionClass = PeerConnectionClass;
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
      audioEnabled: peer.audioEnabled,
      videoEnabled: peer.videoEnabled,
      screenSharing: peer.screenSharing,
    }));
  }

  async joinSession({ sessionId, socket, mode = 'video', sdp }) {
    if (!sessionId || !sdp || !sdp.sdp) {
      throw new Error('Valid sessionId and SDP offer are required.');
    }

    const user = this.users.getUser(socket.id) || {
      id: socket.id,
      name: 'Participant',
      room: sessionId,
    };

    // Clean up any existing peer for this socket in the same session
    await this.leaveSession(sessionId, socket.id, false);

    const session = this.getOrCreateSession(sessionId);
    const pc = new this.PeerConnectionClass({
      iceServers: config.webrtc.iceServers,
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
      forwardedSubscriptions: new Map(), // Map<targetSocketId, Array<{ unSubscribe, forwardTrack, sender }>>
      negotiationChain: Promise.resolve(),
      closed: false,
    };

    session.set(socket.id, peerState);

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate && !peerState.closed) {
        this.io.to(socket.id).emit('sfu:candidate', {
          sessionId,
          candidate: candidate.toJSON ? candidate.toJSON() : candidate,
        });
      }
    });

    pc.onTrack.subscribe((remoteTrack) => {
      if (peerState.closed) return;
      peerState.publishedTracks.push({
        remoteTrack,
        kind: remoteTrack.kind,
      });

      // Forward this newly published track to all other peers currently in the session
      for (const [otherSocketId, otherPeer] of session.entries()) {
        if (otherSocketId !== socket.id && !otherPeer.closed) {
          this.forwardTrackToSubscriber(peerState, remoteTrack, otherPeer);
        }
      }
    });

    // Apply publisher's offer and generate answer
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Attach already-published tracks from existing participants in this session to the new peer
    for (const [otherSocketId, otherPeer] of session.entries()) {
      if (otherSocketId !== socket.id && !otherPeer.closed) {
        for (const pub of otherPeer.publishedTracks) {
          this.forwardTrackToSubscriber(otherPeer, pub.remoteTrack, peerState);
        }
      }
    }

    this.broadcastParticipants(sessionId);

    return {
      sdp: pc.localDescription,
      streamId: peerState.streamId,
      participants: this.getSessionParticipants(sessionId),
    };
  }

  requestPublisherKeyframe(publisherPeer, remoteTrack) {
    if (!publisherPeer || publisherPeer.closed || !remoteTrack || !remoteTrack.ssrc) return;
    try {
      const receivers =
        typeof publisherPeer.pc.getReceivers === 'function'
          ? publisherPeer.pc.getReceivers()
          : [];
      for (const receiver of receivers) {
        if (receiver && typeof receiver.sendRtcpPLI === 'function') {
          receiver.sendRtcpPLI(remoteTrack.ssrc);
        }
      }
    } catch (err) {}
  }

  forwardTrackToSubscriber(publisherPeer, remoteTrack, subscriberPeer) {
    if (publisherPeer.closed || subscriberPeer.closed) return;

    const forwardTrack = new MediaStreamTrack({
      kind: remoteTrack.kind,
    });
    const outStream = new MediaStream({
      id: publisherPeer.streamId,
    });
    outStream.addTrack(forwardTrack);

    const { unSubscribe } = remoteTrack.onReceiveRtp.subscribe((rtp) => {
      if (!forwardTrack.stopped && !subscriberPeer.closed) {
        try {
          forwardTrack.writeRtp(rtp);
        } catch (err) {}
      }
    });

    let sender = null;
    try {
      sender = subscriberPeer.pc.addTrack(forwardTrack, outStream);
      if (sender && sender.onPictureLossIndication && remoteTrack.kind === 'video') {
        sender.onPictureLossIndication.subscribe(() => {
          this.requestPublisherKeyframe(publisherPeer, remoteTrack);
        });
      }
    } catch (err) {
      unSubscribe();
      forwardTrack.stop();
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
      unSubscribe,
      forwardTrack,
      sender,
    });

    this.scheduleRenegotiation(subscriberPeer);
  }

  scheduleRenegotiation(subscriberPeer) {
    if (subscriberPeer.closed) return;

    subscriberPeer.negotiationChain = subscriberPeer.negotiationChain
      .then(async () => {
        if (subscriberPeer.closed) return;
        const offer = await subscriberPeer.pc.createOffer();
        await subscriberPeer.pc.setLocalDescription(offer);

        const trackOwnerMap = {};
        const session = this.sessions.get(subscriberPeer.sessionId);
        if (session) {
          for (const peer of session.values()) {
            trackOwnerMap[peer.streamId] = {
              socketId: peer.socketId,
              name: peer.name,
              mode: peer.mode,
              audioEnabled: peer.audioEnabled,
              videoEnabled: peer.videoEnabled,
              screenSharing: peer.screenSharing,
            };
          }
        }

        this.io.to(subscriberPeer.socketId).emit('sfu:offer', {
          sessionId: subscriberPeer.sessionId,
          sdp: subscriberPeer.pc.localDescription,
          trackOwnerMap,
        });
      })
      .catch(() => {});
  }

  async handleAnswer({ sessionId, socketId, sdp }) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const peer = session.get(socketId);
    if (!peer || peer.closed || !sdp) return false;

    peer.negotiationChain = peer.negotiationChain
      .then(async () => {
        if (!peer.closed) {
          await peer.pc.setRemoteDescription(sdp);
        }
      })
      .catch(() => {});

    await peer.negotiationChain;
    return true;
  }

  async handleCandidate({ sessionId, socketId, candidate }) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const peer = session.get(socketId);
    if (!peer || peer.closed || !candidate) return false;

    try {
      await peer.pc.addIceCandidate(candidate);
      return true;
    } catch (err) {
      return false;
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

  async leaveSession(sessionId, socketId, notify = true) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.has(socketId)) return false;

    const leavingPeer = session.get(socketId);
    leavingPeer.closed = true;
    session.delete(socketId);

    for (const [targetSocketId, forwardList] of leavingPeer.forwardedSubscriptions.entries()) {
      const targetPeer = session.get(targetSocketId);
      for (const item of forwardList) {
        try {
          item.unSubscribe();
          item.forwardTrack.stop();
          if (targetPeer && !targetPeer.closed && item.sender) {
            targetPeer.pc.removeTrack(item.sender);
          }
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

    try {
      await leavingPeer.pc.close();
    } catch (err) {}

    if (session.size === 0) {
      this.sessions.delete(sessionId);
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

  broadcastParticipants(sessionId) {
    const participants = this.getSessionParticipants(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const socketId of session.keys()) {
        this.io.to(socketId).emit('sfu:participants', {
          sessionId,
          participants,
        });
      }
    }
    if (sessionId.startsWith('room:')) {
      const roomName = sessionId.slice(5);
      this.io.to(roomName).emit('sfu:room-call-status', {
        sessionId,
        room: roomName,
        participants,
      });
    }
  }
}

module.exports = { SfuService };
