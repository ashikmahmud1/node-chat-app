const registerCallHandlers = (io, socket, users) => {
  socket.on('initializeAudioCall', (userid) => {
    const caller = users.getUser(socket.id);
    if (!caller || !userid || userid === socket.id) return;
    const recipient = users.getUser(userid);
    if (!recipient) {
      socket.emit('userOffline');
      return;
    }
    if (recipient.status === 'dnd') {
      socket.emit('userBusy');
      return;
    }
    socket.broadcast.to(userid).emit('incomingCall', caller);
  });

  socket.on('initializeVideoCall', (userid) => {
    const caller = users.getUser(socket.id);
    if (!caller || !userid || userid === socket.id) return;
    const recipient = users.getUser(userid);
    if (!recipient) {
      socket.emit('userOffline');
      return;
    }
    if (recipient.status === 'dnd') {
      socket.emit('userVideoBusy');
      return;
    }
    socket.broadcast.to(userid).emit('incomingVideoCall', caller);
  });

  socket.on('callReceived', (userid) => {
    if (!userid || userid === socket.id) return;
    socket.broadcast.to(userid).emit('notifyCallReceived');
  });

  socket.on('videoCallReceived', (userid) => {
    if (!userid || userid === socket.id) return;
    socket.broadcast.to(userid).emit('notifyVideoCallReceived');
  });

  socket.on('callCancelled', (payload) => {
    const targetUserId = typeof payload === 'object' && payload !== null ? payload.userid : payload;
    if (!targetUserId || targetUserId === socket.id) return;
    socket.broadcast.to(targetUserId).emit('callCancelled', {
      callerId: socket.id,
      ...(typeof payload === 'object' ? payload : { userid: targetUserId }),
    });
  });

  socket.on('callEnded', (payload) => {
    const user = users.getUser(socket.id);
    const targetUserId = typeof payload === 'object' && payload !== null ? payload.userid : payload;
    if (!targetUserId || targetUserId === socket.id) return;
    socket.broadcast.to(targetUserId).emit('callEnded', {
      user,
      ...(typeof payload === 'object' ? payload : { userid: targetUserId }),
    });
  });

  socket.on('videoCallEnded', (payload) => {
    const user = users.getUser(socket.id);
    const targetUserId = typeof payload === 'object' && payload !== null ? payload.userid : payload;
    if (!targetUserId || targetUserId === socket.id) return;
    socket.broadcast.to(targetUserId).emit('videoCallEnded', {
      user,
      ...(typeof payload === 'object' ? payload : { userid: targetUserId }),
    });
  });

  socket.on('userBusy', (userid) => {
    if (!userid || userid === socket.id) return;
    socket.broadcast.to(userid).emit('userBusy');
  });

  socket.on('userVideoBusy', (userid) => {
    if (!userid || userid === socket.id) return;
    socket.broadcast.to(userid).emit('userVideoBusy');
  });

  socket.on('callNotReceived', (payload) => {
    const user = users.getUser(socket.id);
    const targetUserId = typeof payload === 'object' && payload !== null ? payload.userid : payload;
    if (!targetUserId || targetUserId === socket.id) return;
    socket.broadcast.to(targetUserId).emit('callNotReceived', {
      user,
      ...(typeof payload === 'object' ? payload : { userid: targetUserId }),
    });
  });

  socket.on('videoCallNotReceived', (payload) => {
    const user = users.getUser(socket.id);
    const targetUserId = typeof payload === 'object' && payload !== null ? payload.userid : payload;
    if (!targetUserId || targetUserId === socket.id) return;
    socket.broadcast.to(targetUserId).emit('videoCallNotReceived', {
      user,
      ...(typeof payload === 'object' ? payload : { userid: targetUserId }),
    });
  });
};

module.exports = { registerCallHandlers };
