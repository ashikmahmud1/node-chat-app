const registerCallHandlers = (io, socket, users) => {
  socket.on('initializeAudioCall', (userid) => {
    const caller = users.getUser(socket.id);
    if (!caller || !userid) return;
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
    if (!caller || !userid) return;
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
    if (!userid) return;
    socket.broadcast.to(userid).emit('notifyCallReceived');
  });

  socket.on('videoCallReceived', (userid) => {
    if (!userid) return;
    socket.broadcast.to(userid).emit('notifyVideoCallReceived');
  });

  socket.on('callCancelled', (userid) => {
    if (!userid) return;
    socket.broadcast.to(userid).emit('callCancelled', socket.id);
  });

  socket.on('audioCall', (stream = {}) => {
    if (!stream.userid || !stream.blob) return;
    socket.broadcast.to(stream.userid).emit('onAudioCall', stream.blob);
  });

  socket.on('videoCall', (stream = {}) => {
    if (!stream.userid || !stream.blob) return;
    socket.broadcast.to(stream.userid).emit('onVideoCall', stream.blob);
  });

  socket.on('callEnded', (userid) => {
    const user = users.getUser(socket.id);
    if (!userid) return;
    socket.broadcast.to(userid).emit('callEnded', user);
  });

  socket.on('videoCallEnded', (userid) => {
    const user = users.getUser(socket.id);
    if (!userid) return;
    socket.broadcast.to(userid).emit('videoCallEnded', user);
  });

  socket.on('userBusy', (userid) => {
    if (!userid) return;
    socket.broadcast.to(userid).emit('userBusy');
  });

  socket.on('userVideoBusy', (userid) => {
    if (!userid) return;
    socket.broadcast.to(userid).emit('userVideoBusy');
  });

  socket.on('callNotReceived', (userid) => {
    if (!userid) return;
    socket.broadcast.to(userid).emit('callNotReceived');
  });

  socket.on('videoCallNotReceived', (userid) => {
    if (!userid) return;
    socket.broadcast.to(userid).emit('videoCallNotReceived');
  });
};

module.exports = { registerCallHandlers };
