const registerSfuHandlers = (io, socket, users, sfuService) => {
  socket.on('sfu:join', async (payload = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    try {
      const result = await sfuService.joinSession({
        sessionId: payload.sessionId,
        socket,
        mode: payload.mode || 'video',
        sdp: payload.sdp,
      });
      respond({ ok: true, ...result });
    } catch (err) {
      respond({ ok: false, error: err.message || 'Failed to join SFU session.' });
    }
  });

  socket.on('sfu:answer', async (payload = {}) => {
    if (!payload.sessionId || !payload.sdp) return;
    await sfuService.handleAnswer({
      sessionId: payload.sessionId,
      socketId: socket.id,
      sdp: payload.sdp,
    });
  });

  socket.on('sfu:candidate', async (payload = {}) => {
    if (!payload.sessionId || !payload.candidate) return;
    await sfuService.handleCandidate({
      sessionId: payload.sessionId,
      socketId: socket.id,
      candidate: payload.candidate,
    });
  });

  socket.on('sfu:media-state', (payload = {}) => {
    if (!payload.sessionId) return;
    sfuService.updateMediaState({
      sessionId: payload.sessionId,
      socketId: socket.id,
      audioEnabled: payload.audioEnabled,
      videoEnabled: payload.videoEnabled,
      screenSharing: payload.screenSharing,
    });
  });

  socket.on('sfu:leave', async (payload = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    if (payload.sessionId) {
      await sfuService.leaveSession(payload.sessionId, socket.id, true);
    } else {
      await sfuService.leaveAllSessions(socket.id);
    }
    respond({ ok: true });
  });

  socket.on('sfu:get-room-status', (payload = {}, callback = () => {}) => {
    const respond = typeof callback === 'function' ? callback : () => {};
    const user = users.getUser(socket.id);
    const room = payload.room || (user ? user.room : '');
    if (!room) return respond({ participants: [] });
    const sessionId = `room:${room}`;
    return respond({
      sessionId,
      participants: sfuService.getSessionParticipants(sessionId),
    });
  });

  socket.on('disconnect', async () => {
    await sfuService.leaveAllSessions(socket.id);
  });
};

module.exports = { registerSfuHandlers };
