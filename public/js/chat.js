var socket = io();

function scrollToBottom(id) {
  var messages = jQuery(id);
  var newMessage = messages.children('li:last-child');
  if (!newMessage.length) return;

  var clientHeight = messages.prop('clientHeight') || 0;
  var scrollTop = messages.prop('scrollTop') || 0;
  var scrollHeight = messages.prop('scrollHeight') || 0;
  var newMessageHeight = newMessage.innerHeight() || 0;
  var lastMessageHeight = newMessage.prev().innerHeight() || 0;

  if (clientHeight + scrollTop + newMessageHeight + lastMessageHeight >= scrollHeight) {
    messages.scrollTop(scrollHeight);
  }
}

var calling = false;
var caller_id = '';
var video_caller_id = '';
var callTimerTimeout = null;
var ringTimeout = null;
var videoRingTimeout = null;
var audio_message = null;
var activeMediaStream = null;
var activeMediaRecorder = null;

// WebRTC SFU State (1-to-1 & Multi-user Room Calls)
var rtcIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
var currentRoomName = 'General';
var currentUserName = 'Me';
var privateSfuSessionId = '';
var privateSfuPc = null;
var roomSfuSessionId = '';
var roomSfuPc = null;
var roomLocalStream = null;
var roomScreenStream = null;
var roomCallActive = false;
var roomCallTimerTimeout = null;
var roomTrackOwners = {};

// Message Deduplication, Reactions & Typing State
var rendered_message_ids = {};
var room_typing_users = {};
var roomTypingStopTimeout = null;
var privateTypingStopTimeout = null;
var QUICK_REACTIONS = ['👍', '❤️', '🎉', '🚀'];

if (window.fetch) {
  fetch('/api/rtc-config')
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        rtcIceServers = data.iceServers;
      }
    })
    .catch(function () {});
}

// Dictionary storing private message history per user ID
var user_message_dictionary = {};
// Persistent unread badge counter per user ID
var unread_counts = {};
// Map of active users in the room by socket ID
var room_users_map = {};

// DOM Elements
var progress_bar = document.getElementById('upload-progress-bar');
var progress_bar_inner = document.getElementById('upload-progress-bar-inner');
var private_btn_id = document.getElementsByClassName('private-message-send');
var modal_close_button = document.getElementsByClassName('close');
var private_progress_bar = document.getElementById('private-upload-progress-bar');
var private_progress_bar_inner = document.getElementById('private-upload-progress-bar-inner');
var message_audio = document.getElementById('message-received');
var calling_audio = document.getElementById('audioCalling');

function playNotificationSound() {
  if (!message_audio) return;
  message_audio.src = '/sound/iphone_notification.mp3';
  var playPromise = message_audio.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(function () {});
  }
}

function getPrivateSessionId(peerIdA, peerIdB) {
  var pair = [peerIdA, peerIdB].sort();
  return 'private:' + pair[0] + ':' + pair[1];
}

function updateUnreadBadgeDOM(userId) {
  var userBtn = document.getElementById(userId);
  if (!userBtn || !userBtn.nextSibling) return;
  var label = userBtn.nextSibling;
  var count = unread_counts[userId] || 0;
  if (count > 0) {
    label.setAttribute('style', 'display:block');
    label.innerHTML = String(count);
  } else {
    label.setAttribute('style', 'display:none');
    label.innerHTML = '';
  }
}

function incrementUnreadBadge(userId) {
  if (!userId) return;
  unread_counts[userId] = (unread_counts[userId] || 0) + 1;
  updateUnreadBadgeDOM(userId);
}

function clearUnreadBadge(userId) {
  if (!userId) return;
  unread_counts[userId] = 0;
  updateUnreadBadgeDOM(userId);
}

function clearRingTimeout() {
  if (ringTimeout) {
    clearTimeout(ringTimeout);
    ringTimeout = null;
  }
}

function clearVideoRingTimeout() {
  if (videoRingTimeout) {
    clearTimeout(videoRingTimeout);
    videoRingTimeout = null;
  }
}

function formatNextSecond(currentText) {
  var ss = (currentText || '00:00').split(':');
  var dt = new Date();
  dt.setHours(0);
  dt.setMinutes(parseInt(ss[0], 10) || 0);
  dt.setSeconds(parseInt(ss[1], 10) || 0);

  var dt2 = new Date(dt.valueOf() + 1000);
  var temp = dt2.toTimeString().split(' ');
  var ts = temp[0].split(':');
  return ts[1] + ':' + ts[2];
}

function update() {
  if (!calling) return;
  var $worked = $('#show-time');
  $worked.html(formatNextSecond($worked.html()));
  callTimerTimeout = setTimeout(update, 1000);
}

function stopCallTimer() {
  if (callTimerTimeout) {
    clearTimeout(callTimerTimeout);
    callTimerTimeout = null;
  }
}

function updateRoomTimer() {
  if (!roomCallActive) return;
  var $timer = $('#room-call-timer');
  $timer.html(formatNextSecond($timer.html()));
  roomCallTimerTimeout = setTimeout(updateRoomTimer, 1000);
}

function stopRoomCallTimer() {
  if (roomCallTimerTimeout) {
    clearTimeout(roomCallTimerTimeout);
    roomCallTimerTimeout = null;
  }
}

function closePrivateSfuConnection() {
  if (privateSfuSessionId) {
    socket.emit('sfu:leave', { sessionId: privateSfuSessionId });
    privateSfuSessionId = '';
  }
  if (privateSfuPc) {
    try {
      privateSfuPc.close();
    } catch (e) {}
    privateSfuPc = null;
  }
}

function stopMediaStream() {
  closePrivateSfuConnection();

  if (audio_message) {
    clearInterval(audio_message);
    audio_message = null;
  }
  if (activeMediaRecorder && activeMediaRecorder.state !== 'inactive') {
    try {
      activeMediaRecorder.onstop = null;
      activeMediaRecorder.stop();
    } catch (e) {}
  }
  activeMediaRecorder = null;

  if (activeMediaStream) {
    activeMediaStream.getTracks().forEach(function (track) {
      track.stop();
    });
    activeMediaStream = null;
  }

  var selfVideo = document.getElementById('self-video');
  if (selfVideo) {
    selfVideo.srcObject = null;
    $('#self-video').addClass('self-video');
  }
  var otherVideo = document.getElementById('other-video');
  if (otherVideo) {
    otherVideo.srcObject = null;
  }
}

/* ==========================================================================
   WebRTC SFU Client Engine (1-to-1 Private Calls & Multi-User Room Calls)
   ========================================================================== */

function startPrivateSfuSession(targetUserId, mode, mediaStream) {
  if (!window.RTCPeerConnection || !targetUserId) return false;

  closePrivateSfuConnection();
  privateSfuSessionId = getPrivateSessionId(socket.id, targetUserId);
  var pc = new RTCPeerConnection({
    iceServers: rtcIceServers,
  });
  privateSfuPc = pc;

  mediaStream.getTracks().forEach(function (track) {
    pc.addTrack(track, mediaStream);
  });

  pc.onicecandidate = function (event) {
    if (event.candidate && privateSfuSessionId) {
      socket.emit('sfu:candidate', {
        sessionId: privateSfuSessionId,
        candidate: event.candidate,
      });
    }
  };

  pc.ontrack = function (event) {
    var remoteStream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
    if (event.track.kind === 'video' || mode === 'video') {
      var otherVideo = document.getElementById('other-video');
      if (otherVideo) {
        otherVideo.srcObject = remoteStream;
        $('#other-video').removeClass('other-video');
      }
    } else if (calling_audio) {
      calling_audio.srcObject = remoteStream;
    }
  };

  pc.createOffer()
    .then(function (offer) {
      return pc.setLocalDescription(offer);
    })
    .then(function () {
      socket.emit(
        'sfu:join',
        {
          sessionId: privateSfuSessionId,
          mode: mode,
          sdp: pc.localDescription,
        },
        function (res) {
          if (res && res.ok && res.sdp && privateSfuPc === pc) {
            pc.setRemoteDescription(new RTCSessionDescription(res.sdp)).catch(function () {});
          }
        }
      );
    })
    .catch(function (err) {
      console.error('Private SFU negotiation error:', err);
    });

  return true;
}

function renderRoomVideoTile(streamId, labelText, stream, isSelf) {
  var grid = document.getElementById('room-video-grid');
  if (!grid) return;

  var tileId = 'sfu-tile-' + streamId.replace(/[^a-zA-Z0-9_-]/g, '_');
  var existingTile = document.getElementById(tileId);
  var videoEl;

  if (!existingTile) {
    existingTile = document.createElement('div');
    existingTile.className = 'sfu-video-tile';
    existingTile.id = tileId;

    videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    if (isSelf) {
      videoEl.muted = true;
    }

    var badge = document.createElement('div');
    badge.className = 'sfu-video-tile__label';
    badge.innerHTML = '<i class="fa fa-user" aria-hidden="true"></i> <span></span>';
    badge.querySelector('span').textContent = labelText;

    existingTile.appendChild(videoEl);
    existingTile.appendChild(badge);
    grid.appendChild(existingTile);
  } else {
    videoEl = existingTile.querySelector('video');
    var nameSpan = existingTile.querySelector('.sfu-video-tile__label span');
    if (nameSpan && labelText) {
      nameSpan.textContent = labelText;
    }
  }

  if (videoEl && stream && videoEl.srcObject !== stream) {
    videoEl.srcObject = stream;
  }
}

function removeRoomVideoTile(streamId) {
  if (!streamId) return;
  var tileId = 'sfu-tile-' + streamId.replace(/[^a-zA-Z0-9_-]/g, '_');
  var tile = document.getElementById(tileId);
  if (tile && tile.parentNode) {
    var vid = tile.querySelector('video');
    if (vid) vid.srcObject = null;
    tile.parentNode.removeChild(tile);
  }
}

function joinRoomSfuCall(mode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return alert('WebRTC media devices are not supported in this browser.');
  }

  if (roomCallActive) {
    leaveRoomSfuCall();
  }

  var constraints = {
    audio: true,
    video: mode === 'video',
  };

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then(function (mediaStream) {
      roomLocalStream = mediaStream;
      roomCallActive = true;
      roomSfuSessionId = 'room:' + currentRoomName;

      $('#room-call-stage').removeClass('hide-element');
      $('#room-call-mode-label').text(
        currentRoomName + ' — SFU ' + (mode === 'video' ? 'Video' : 'Audio') + ' Conference'
      );
      $('#room-call-timer').html('00:00');
      stopRoomCallTimer();
      roomCallTimerTimeout = setTimeout(updateRoomTimer, 1000);

      var grid = document.getElementById('room-video-grid');
      if (grid) grid.innerHTML = '';

      renderRoomVideoTile('local-self', currentUserName + ' (You)', mediaStream, true);

      var pc = new RTCPeerConnection({
        iceServers: rtcIceServers,
      });
      roomSfuPc = pc;

      mediaStream.getTracks().forEach(function (track) {
        pc.addTrack(track, mediaStream);
      });

      pc.onicecandidate = function (event) {
        if (event.candidate && roomSfuSessionId) {
          socket.emit('sfu:candidate', {
            sessionId: roomSfuSessionId,
            candidate: event.candidate,
          });
        }
      };

      pc.ontrack = function (event) {
        var remoteStream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
        var streamId = remoteStream.id || event.track.id;
        var ownerInfo = roomTrackOwners[streamId];
        var label = ownerInfo ? ownerInfo.name : 'Participant';
        renderRoomVideoTile(streamId, label, remoteStream, false);
      };

      return pc
        .createOffer()
        .then(function (offer) {
          return pc.setLocalDescription(offer);
        })
        .then(function () {
          socket.emit(
            'sfu:join',
            {
              sessionId: roomSfuSessionId,
              mode: mode,
              sdp: pc.localDescription,
            },
            function (res) {
              if (res && res.ok && res.sdp && roomSfuPc === pc) {
                pc.setRemoteDescription(new RTCSessionDescription(res.sdp)).catch(function () {});
              }
            }
          );
        });
    })
    .catch(function (err) {
      console.error('Failed to join Room SFU call:', err);
      alert('Unable to access microphone/camera for the room call.');
      leaveRoomSfuCall();
    });
}

function stopScreenShareTrack() {
  if (roomScreenStream) {
    roomScreenStream.getTracks().forEach(function (track) {
      track.stop();
    });
    roomScreenStream = null;
  }
  $('#room-toggle-screen').removeClass('muted-state');
}

function toggleRoomScreenShare() {
  if (!roomCallActive || !roomSfuPc) return;

  if (roomScreenStream) {
    stopScreenShareTrack();
    if (roomLocalStream) {
      var camTrack = roomLocalStream.getVideoTracks()[0];
      var sender = roomSfuPc.getSenders().find(function (s) {
        return s.track && s.track.kind === 'video';
      });
      if (sender && camTrack) {
        sender.replaceTrack(camTrack);
      }
      renderRoomVideoTile('local-self', currentUserName + ' (You)', roomLocalStream, true);
    }
    socket.emit('sfu:media-state', {
      sessionId: roomSfuSessionId,
      screenSharing: false,
    });
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return alert('Screen sharing is not supported in this browser.');
  }

  navigator.mediaDevices
    .getDisplayMedia({ video: true })
    .then(function (displayStream) {
      roomScreenStream = displayStream;
      var screenTrack = displayStream.getVideoTracks()[0];
      if (!screenTrack) return;

      var videoSender = roomSfuPc.getSenders().find(function (s) {
        return s.track && s.track.kind === 'video';
      });
      if (videoSender) {
        videoSender.replaceTrack(screenTrack);
      } else {
        roomSfuPc.addTrack(screenTrack, displayStream);
      }

      renderRoomVideoTile('local-self', currentUserName + ' (Screen)', displayStream, true);
      $('#room-toggle-screen').addClass('muted-state');

      socket.emit('sfu:media-state', {
        sessionId: roomSfuSessionId,
        screenSharing: true,
      });

      screenTrack.onended = function () {
        if (roomScreenStream) {
          toggleRoomScreenShare();
        }
      };
    })
    .catch(function () {});
}

function leaveRoomSfuCall() {
  roomCallActive = false;
  stopRoomCallTimer();
  stopScreenShareTrack();

  if (roomSfuSessionId) {
    socket.emit('sfu:leave', { sessionId: roomSfuSessionId });
    roomSfuSessionId = '';
  }

  if (roomSfuPc) {
    try {
      roomSfuPc.close();
    } catch (e) {}
    roomSfuPc = null;
  }

  if (roomLocalStream) {
    roomLocalStream.getTracks().forEach(function (track) {
      track.stop();
    });
    roomLocalStream = null;
  }

  var grid = document.getElementById('room-video-grid');
  if (grid) grid.innerHTML = '';
  $('#room-call-stage').addClass('hide-element');
  $('#room-toggle-mic').removeClass('muted-state');
  $('#room-toggle-cam').removeClass('muted-state');
}

// SFU Signaling Listeners
socket.on('sfu:offer', function (data) {
  if (!data || !data.sessionId || !data.sdp) return;

  if (data.trackOwnerMap) {
    Object.keys(data.trackOwnerMap).forEach(function (streamId) {
      roomTrackOwners[streamId] = data.trackOwnerMap[streamId];
    });
  }

  var targetPc = null;
  if (data.sessionId === roomSfuSessionId) {
    targetPc = roomSfuPc;
  } else if (data.sessionId === privateSfuSessionId) {
    targetPc = privateSfuPc;
  }
  if (!targetPc) return;

  targetPc
    .setRemoteDescription(new RTCSessionDescription(data.sdp))
    .then(function () {
      return targetPc.createAnswer();
    })
    .then(function (answer) {
      return targetPc.setLocalDescription(answer);
    })
    .then(function () {
      socket.emit('sfu:answer', {
        sessionId: data.sessionId,
        sdp: targetPc.localDescription,
      });
    })
    .catch(function (err) {
      console.error('SFU renegotiation error:', err);
    });
});

socket.on('sfu:candidate', function (data) {
  if (!data || !data.sessionId || !data.candidate) return;
  var targetPc = null;
  if (data.sessionId === roomSfuSessionId) {
    targetPc = roomSfuPc;
  } else if (data.sessionId === privateSfuSessionId) {
    targetPc = privateSfuPc;
  }
  if (!targetPc) return;

  targetPc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function () {});
});

socket.on('sfu:participant-left', function (data) {
  if (!data) return;
  if (data.sessionId === roomSfuSessionId && data.streamId) {
    removeRoomVideoTile(data.streamId);
  }
});

socket.on('sfu:room-call-status', function (data) {
  if (!data || !Array.isArray(data.participants)) return;
  var count = data.participants.length;
  if (count > 0) {
    $('#room-call-count').text(String(count));
    $('#room-call-active-badge').removeClass('hide-element');
  } else {
    $('#room-call-active-badge').addClass('hide-element');
  }
});

// Room SFU Call Controls
$('#join-room-audio-btn').on('click', function () {
  joinRoomSfuCall('audio');
});

$('#join-room-video-btn').on('click', function () {
  joinRoomSfuCall('video');
});

$('#room-leave-call').on('click', function () {
  leaveRoomSfuCall();
});

$('#room-toggle-screen').on('click', function () {
  toggleRoomScreenShare();
});

$('#room-toggle-mic').on('click', function () {
  if (!roomLocalStream) return;
  var audioTracks = roomLocalStream.getAudioTracks();
  if (!audioTracks.length) return;
  var enabled = !audioTracks[0].enabled;
  audioTracks.forEach(function (t) {
    t.enabled = enabled;
  });
  $('#room-toggle-mic').toggleClass('muted-state', !enabled);
  if (roomSfuSessionId) {
    socket.emit('sfu:media-state', {
      sessionId: roomSfuSessionId,
      audioEnabled: enabled,
    });
  }
});

$('#room-toggle-cam').on('click', function () {
  if (!roomLocalStream) return;
  var videoTracks = roomLocalStream.getVideoTracks();
  if (!videoTracks.length) return;
  var enabled = !videoTracks[0].enabled;
  videoTracks.forEach(function (t) {
    t.enabled = enabled;
  });
  $('#room-toggle-cam').toggleClass('muted-state', !enabled);
  if (roomSfuSessionId) {
    socket.emit('sfu:media-state', {
      sessionId: roomSfuSessionId,
      videoEnabled: enabled,
    });
  }
});

// Presence Status Selector
$('#presence-status-select').on('change', function () {
  var status = $(this).val();
  socket.emit('presence:update', { status: status });
});

// Live Room Message Search Filter
$('#room-message-search').on('input', function () {
  var query = ($(this).val() || '').trim().toLowerCase();
  $('#messages li.message').each(function () {
    var $li = $(this);
    var textContent = ($li.text() || '').toLowerCase();
    if (!query || textContent.indexOf(query) !== -1) {
      $li.show();
    } else {
      $li.hide();
    }
  });
});

// Private Call Mic/Cam Toggle Controls
$('#private-toggle-mic-audio, #private-toggle-mic-video').on('click', function () {
  if (!activeMediaStream) return;
  var audioTracks = activeMediaStream.getAudioTracks();
  if (!audioTracks.length) return;
  var enabled = !audioTracks[0].enabled;
  audioTracks.forEach(function (t) {
    t.enabled = enabled;
  });
});

$('#private-toggle-cam-video').on('click', function () {
  if (!activeMediaStream) return;
  var videoTracks = activeMediaStream.getVideoTracks();
  if (!videoTracks.length) return;
  var enabled = !videoTracks[0].enabled;
  videoTracks.forEach(function (t) {
    t.enabled = enabled;
  });
});

function privateScrollToBottom() {
  var modal = document.getElementsByClassName('modal-body')[0];
  if (modal) {
    modal.scrollTop = modal.scrollHeight;
  }
}

function privateScrollToTop() {
  var modal = document.getElementsByClassName('modal-body')[0];
  if (modal) {
    modal.scrollTop = 0;
  }
}

function getActivePrivateUserId() {
  if (private_btn_id[0] && private_btn_id[0].id) {
    return private_btn_id[0].id.slice(0, -1);
  }
  return '';
}

function openPrivateModalForUser(userId, userName) {
  if (!userId) return;
  private_btn_id[0].setAttribute('id', userId + '0');
  document.getElementsByClassName('modal-title')[0].innerHTML = userName || 'Private Chat';
  $('#private-typing-indicator').addClass('hide-element').text('');
  clearUnreadBadge(userId);
  renderPrivateMessages(userId);
  $('#myModal').modal('show');
}

function renderPrivateMessages(userId) {
  var $list = jQuery('#private_messages_list');
  $list.empty();

  if (!(userId in user_message_dictionary)) return;

  var messages = user_message_dictionary[userId];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var template;
    var html;

    if (msg.type === 'location') {
      template = jQuery('#location-message-template').html();
      html = Mustache.render(template, {
        from: msg.from,
        url: msg.url,
        createdAt: msg.createdAt,
      });
    } else if (msg.type === 'file') {
      template = jQuery('#file-message-template').html();
      html = Mustache.render(template, {
        from: msg.from,
        url: msg.url,
        createdAt: msg.createdAt,
      });
    } else {
      template = jQuery('#private-message-template').html();
      html = Mustache.render(template, {
        text: msg.text,
        from: msg.from,
        createdAt: msg.createdAt,
      });
    }
    $list.append(html);
  }
  if (!calling) {
    privateScrollToBottom();
  }
}

$('#alert-box').on('click', function () {
  var pendingCallerId = caller_id || video_caller_id;
  if (!pendingCallerId || !room_users_map[pendingCallerId]) return;
  var callerUser = room_users_map[pendingCallerId];
  openPrivateModalForUser(callerUser.id, callerUser.name);
  $('#alert-box').addClass('alert-hide');

  if (caller_id === pendingCallerId) {
    document.getElementById('audio-calling-text').innerHTML = callerUser.name + ' Calling......';
    $('#call-receive-section').removeClass('accept-reject-call');
    $('#audio-call').attr('disabled', true);
    $('#video-call').attr('disabled', true);
    modal_close_button[0].setAttribute('disabled', 'disabled');
  } else if (video_caller_id === pendingCallerId) {
    document.getElementById('video-calling-text').innerHTML =
      callerUser.name + ' Video Calling......';
    $('#video-call-receive-section').removeClass('accept-reject-video-call');
    $('#audio-call').attr('disabled', true);
    $('#video-call').attr('disabled', true);
    modal_close_button[0].setAttribute('disabled', 'disabled');
  }
});

// Build reaction & edit/delete toolbar for public room messages
function renderMessageReactions($li, messageId, reactions) {
  var $bar = $li.find('.reaction-bar');
  if (!$bar.length) return;
  $bar.empty();

  var reactionMap = reactions || {};
  QUICK_REACTIONS.forEach(function (emoji) {
    var usersList = Array.isArray(reactionMap[emoji]) ? reactionMap[emoji] : [];
    var count = usersList.length;
    var isMine = usersList.indexOf(currentUserName) !== -1;

    var $btn = $('<button type="button" class="reaction-btn"></button>');
    if (isMine) $btn.addClass('active-reaction');
    $btn.text(count > 0 ? emoji + ' ' + count : emoji);
    if (count > 0) {
      $btn.attr('title', usersList.join(', '));
    }
    $btn.on('click', function () {
      socket.emit('message:reaction', {
        messageId: messageId,
        emoji: emoji,
      });
    });
    $bar.append($btn);
  });
}

function appendRoomMessageItem(message) {
  if (!message) return;
  if (message.id && rendered_message_ids[message.id]) return;
  if (message.id) {
    rendered_message_ids[message.id] = true;
  }

  var formattedTime = moment(message.createdAt).format('h:mm a');
  var template;
  var html;
  var isTextMessage = false;

  if (message.type === 'location' || (message.url && message.url.indexOf('google.com/maps') !== -1)) {
    template = jQuery('#location-message-template').html();
    html = Mustache.render(template, {
      from: message.from,
      url: message.url,
      createdAt: formattedTime,
    });
  } else if (message.type === 'file' || message.fileUrl || message.fileurl) {
    var fileUrl = message.fileUrl || message.fileurl || message.url;
    template = jQuery('#file-message-template').html();
    html = Mustache.render(template, {
      from: message.from,
      url: fileUrl,
      createdAt: formattedTime,
    });
  } else {
    isTextMessage = true;
    template = jQuery('#message-template').html();
    html = Mustache.render(template, {
      text: message.text,
      from: message.from,
      createdAt: formattedTime,
    });
  }

  var $li = jQuery(html);
  if (message.id) {
    $li.attr('data-message-id', message.id);
  }
  if (message.edited) {
    $li.find('.user-time').after('<span class="edited-tag">(edited)</span>');
  }

  if (message.id && message.from !== 'Admin') {
    var $toolbar = $('<div class="message-toolbar"></div>');
    var $reactionBar = $('<div class="reaction-bar"></div>');
    $toolbar.append($reactionBar);

    if (message.from === currentUserName) {
      var $ownerActions = $('<div class="msg-owner-actions"></div>');
      if (isTextMessage) {
        var $editBtn = $(
          '<button type="button" class="msg-action-btn" title="Edit message"><i class="fa fa-pencil"></i></button>'
        );
        $editBtn.on('click', function () {
          var currentText = $li.find('.message__body p').text();
          var updatedText = window.prompt('Edit your message:', currentText);
          if (updatedText && updatedText.trim() && updatedText.trim() !== currentText) {
            socket.emit('message:edit', {
              messageId: message.id,
              text: updatedText.trim(),
            });
          }
        });
        $ownerActions.append($editBtn);
      }

      var $delBtn = $(
        '<button type="button" class="msg-action-btn msg-action-delete" title="Delete message"><i class="fa fa-trash-o"></i></button>'
      );
      $delBtn.on('click', function () {
        socket.emit('message:delete', { messageId: message.id });
      });
      $ownerActions.append($delBtn);
      $toolbar.append($ownerActions);
    }

    $li.append($toolbar);
    renderMessageReactions($li, message.id, message.reactions);
  }

  jQuery('#messages').append($li);
  scrollToBottom('#messages');
}

socket.on('roomHistory', function (messages) {
  if (!Array.isArray(messages)) return;
  messages.forEach(function (msg) {
    appendRoomMessageItem(msg);
  });
});

socket.on('message:edited', function (data) {
  if (!data || !data.messageId) return;
  var $li = $('#messages li.message[data-message-id="' + data.messageId + '"]');
  if (!$li.length) return;
  $li.find('.message__body p').text(data.text);
  if (!$li.find('.edited-tag').length) {
    $li.find('.user-time').after('<span class="edited-tag">(edited)</span>');
  }
});

socket.on('message:deleted', function (data) {
  if (!data || !data.messageId) return;
  delete rendered_message_ids[data.messageId];
  $('#messages li.message[data-message-id="' + data.messageId + '"]').remove();
});

socket.on('message:reaction-updated', function (data) {
  if (!data || !data.messageId) return;
  var $li = $('#messages li.message[data-message-id="' + data.messageId + '"]');
  if (!$li.length) return;
  renderMessageReactions($li, data.messageId, data.reactions);
});

// Typing indicators (Room & Private)
function updateRoomTypingBanner() {
  var names = Object.keys(room_typing_users).map(function (uid) {
    return room_typing_users[uid];
  });
  var $banner = $('#room-typing-indicator');
  if (names.length === 0) {
    $banner.addClass('hide-element').text('');
  } else if (names.length === 1) {
    $banner.removeClass('hide-element').text(names[0] + ' is typing...');
  } else {
    $banner.removeClass('hide-element').text(names.join(', ') + ' are typing...');
  }
}

socket.on('typing:update', function (data) {
  if (!data || !data.userId) return;
  if (data.isTyping && data.name) {
    room_typing_users[data.userId] = data.name;
  } else {
    delete room_typing_users[data.userId];
  }
  updateRoomTypingBanner();
});

socket.on('private:typing', function (data) {
  if (!data || !data.userId) return;
  if (getActivePrivateUserId() !== data.userId) return;
  var $indicator = $('#private-typing-indicator');
  if (data.isTyping && data.name) {
    $indicator.removeClass('hide-element').text(data.name + ' is typing...');
  } else {
    $indicator.addClass('hide-element').text('');
  }
});

socket.on('newPrivateFileMessage', function (info) {
  var formattedTime = moment(info.createdAt).format('h:mm a');
  var filename = info.fileInfo && info.fileInfo.filename ? info.fileInfo.filename : '';
  var message_object = {
    from: info.user.name,
    url: filename,
    createdAt: formattedTime,
    type: 'file',
  };
  add_message(message_object, info.user.id);

  var slice_user_id = getActivePrivateUserId();
  if (slice_user_id === info.user.id) {
    var template = jQuery('#file-message-template').html();
    var html = Mustache.render(template, {
      from: info.user.name,
      url: filename,
      createdAt: formattedTime,
    });

    jQuery('#private_messages_list').append(html);
    if (!calling) {
      privateScrollToBottom();
    }
    socket.emit('privateFileSendSuccessful', info);
    playNotificationSound();
  } else {
    playNotificationSound();
    socket.emit('privateFileSendSuccessful', info);
    incrementUnreadBadge(info.user.id);
  }
});

socket.on('privateFileSendSuccessful', function (info) {
  var formattedTime = moment(info.createdAt).format('h:mm a');
  var message_object = {
    from: info.user.name,
    url: info.filename,
    createdAt: formattedTime,
    type: 'file',
  };
  add_message(message_object, info.id);

  if (getActivePrivateUserId() === info.id) {
    var template = jQuery('#file-message-template').html();
    var html = Mustache.render(template, {
      from: info.user.name,
      url: info.filename,
      createdAt: formattedTime,
    });

    jQuery('#private_messages_list').append(html);
    if (!calling) {
      privateScrollToBottom();
    }
  }
});

window.addEventListener('load', function () {
  $('#myModal').modal('hide');
});

socket.on('newFileMessage', function (message) {
  appendRoomMessageItem(message);
});

function uploadFile(fileEl) {
  if (!fileEl || !fileEl.files || !fileEl.files[0]) return;

  var formData = new FormData();
  formData.append('file', fileEl.files[0]);

  $.ajax({
    url: '/upload',
    type: 'POST',
    data: formData,
    processData: false,
    contentType: false,
    xhr: function () {
      var xhr = new window.XMLHttpRequest();
      if (private_btn_id[0].id === '') {
        progress_bar.classList.remove('progress-hide');
      } else {
        modal_close_button[0].setAttribute('disabled', 'disabled');
        private_progress_bar.classList.remove('private-progress-hide');
      }

      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) {
          var percent = (e.loaded / e.total) * 100;
          var width = 'width:' + percent + '%';
          if (private_btn_id[0].id === '') {
            progress_bar_inner.setAttribute('style', width);
            progress_bar_inner.innerHTML = percent.toFixed(2) + ' %';
          } else {
            private_progress_bar_inner.setAttribute('style', width);
            private_progress_bar_inner.innerHTML = percent.toFixed(2) + ' %';
          }
        }
      });

      return xhr;
    },
    success: function (fileData) {
      var fileInfo = fileData.file;
      if (!fileInfo) return;

      if (private_btn_id[0].id === '') {
        progress_bar.classList.add('progress-hide');
        socket.emit('newFileMessage', fileInfo);
      } else {
        private_progress_bar.classList.add('private-progress-hide');
        var userid = getActivePrivateUserId();
        socket.emit('newPrivateFileMessage', {
          fileInfo: fileInfo,
          userid: userid,
        });
        modal_close_button[0].removeAttribute('disabled');
      }
    },
    error: function (xhr) {
      var errMsg =
        (xhr && xhr.responseJSON && xhr.responseJSON.error) ||
        'Failed to upload file. Please try again.';
      if (modal_close_button[0]) {
        modal_close_button[0].removeAttribute('disabled');
      }
      alert(errMsg);
    },
    complete: function () {
      progress_bar.classList.add('progress-hide');
      private_progress_bar.classList.add('private-progress-hide');
      fileEl.value = '';
    },
  });
}

$('#input-file').on('change', function (event) {
  if (!event.target.files || !event.target.files[0]) return;
  var fileEl = document.getElementById('input-file');
  uploadFile(fileEl);
});

$('#private-send-file').on('change', function (event) {
  if (!event.target.files || !event.target.files[0]) return;
  var fileEl = document.getElementById('private-send-file');
  uploadFile(fileEl);
});

function upload_file() {
  $('#input-file').click();
}

function upload_private_file() {
  $('#private-send-file').click();
}

socket.on('connect', function () {
  var params = jQuery.deparam(window.location.search);
  currentRoomName = (params && params.room) || 'General';
  currentUserName = (params && params.name) || 'Me';

  $('#header-room-title').text('# ' + currentRoomName);
  $('#sidebar-room-name').text('# ' + currentRoomName);

  socket.emit('join', params, function (err) {
    if (err) {
      alert(err);
      window.location.href = '/';
    } else {
      socket.emit('sfu:get-room-status', { room: currentRoomName }, function (res) {
        if (res && Array.isArray(res.participants) && res.participants.length > 0) {
          $('#room-call-count').text(String(res.participants.length));
          $('#room-call-active-badge').removeClass('hide-element');
        }
      });
    }
  });
});

function private_chat(event) {
  var id = event.target.id;
  if (!id || id === socket.id) return;

  var targetUser = room_users_map[id];
  var targetName = targetUser ? targetUser.name : 'Private Chat';

  openPrivateModalForUser(id, targetName);

  if (caller_id === id) {
    document.getElementById('audio-calling-text').innerHTML = targetName + ' Calling......';
    $('#call-receive-section').removeClass('accept-reject-call');
    $('#alert-box').addClass('alert-hide');
  }
  if (video_caller_id === id) {
    document.getElementById('video-calling-text').innerHTML = targetName + ' Video Calling......';
    $('#video-call-receive-section').removeClass('accept-reject-video-call');
    $('#alert-box').addClass('alert-hide');
  }

  socket.emit('privateMessageWindow', {
    id: id,
  });
}

socket.on('disconnect', function () {
  console.log('Disconnected from server');
});

socket.on('updateUserList', function (users) {
  var userfound = false;
  var activePrivateId = getActivePrivateUserId();
  var ol = jQuery('<ol></ol>');
  room_users_map = {};

  $('#online-count').text(String(users.length));

  users.forEach(function (user) {
    room_users_map[user.id] = user;
    if (user.id === socket.id && user.room) {
      currentRoomName = user.room;
      currentUserName = user.name;
      $('#header-room-title').text('# ' + user.room);
      $('#sidebar-room-name').text('# ' + user.room);
    }

    var isSelf = user.id === socket.id;
    var status = user.status || 'online';
    var statusLabel = status === 'dnd' ? ' (DND)' : status === 'away' ? ' (Away)' : '';
    var displayName = isSelf ? user.name + ' (You)' : user.name + statusLabel;

    var list = $('<li></li>').attr('class', 'user-list');
    var nameRow = $('<div></div>');
    var dot = $('<span></span>').attr('class', 'user-status-dot status-' + status);
    nameRow.append(dot).append(document.createTextNode(displayName));
    list.append(nameRow);
    ol.append(list);

    if (!isSelf) {
      var button = document.createElement('button');
      button.innerHTML = 'Send Message';
      button.classList.add('btn', 'btn-success', 'private-msg-btn');
      button.setAttribute('id', user.id);

      var label = document.createElement('label');
      label.setAttribute('class', 'new-message');
      var unread = unread_counts[user.id] || 0;
      if (unread > 0) {
        label.setAttribute('style', 'display:block');
        label.innerHTML = String(unread);
      }

      list.append(button);
      list.append(label);
    }

    if (activePrivateId && activePrivateId === user.id) {
      userfound = true;
    }
  });

  if (caller_id && !room_users_map[caller_id]) {
    clearRingTimeout();
    caller_id = '';
    $('#call-receive-section').addClass('accept-reject-call');
    $('#alert-box').addClass('alert-hide');
  }
  if (video_caller_id && !room_users_map[video_caller_id]) {
    clearVideoRingTimeout();
    video_caller_id = '';
    $('#video-call-receive-section').addClass('accept-reject-video-call');
    $('#alert-box').addClass('alert-hide');
  }

  if (activePrivateId && !userfound) {
    if (calling) {
      end_call();
      end_video_call();
      calling = false;
    }
  }

  jQuery('#users').html(ol);
  $('.private-msg-btn').on('click', private_chat);
});

socket.on('notifyUser', function (data) {
  if (!data || !data.user) return;
  if (getActivePrivateUserId() === '') {
    openPrivateModalForUser(data.user.id, data.user.name);
    playNotificationSound();
  }

  socket.emit('private_connection_successful', {
    user: data.user,
    otherUserId: data.otherUser,
  });
});

socket.on('openChatWindow', function (data) {
  if (!data || !data.user) return;
  if (getActivePrivateUserId() !== data.user.id) {
    openPrivateModalForUser(data.user.id, data.user.name);
  }
});

document.getElementsByClassName('close')[0].addEventListener('click', function () {
  var private_message_button = document.getElementsByClassName('private-message-send');
  private_message_button[0].setAttribute('id', '');
  document.getElementById('private_messages_list').innerHTML = '';
  $('#private-typing-indicator').addClass('hide-element').text('');
  $('#video-call-receive-section').addClass('accept-reject-video-call');
  $('#call-receive-section').addClass('accept-reject-call');
});

$('#myModal').modal({
  backdrop: 'static',
  keyboard: true,
  show: false,
});

socket.on('newMessage', function (message) {
  appendRoomMessageItem(message);
});

socket.on('newPrivateMessage', function (message) {
  var formattedTime = moment(message.createdAt).format('h:mm a');
  var message_object = {
    text: message.message,
    from: message.user.name,
    createdAt: formattedTime,
    type: 'message',
  };
  add_message(message_object, message.user.id);

  var slice_id = getActivePrivateUserId();

  if (slice_id === message.user.id) {
    $('#private-typing-indicator').addClass('hide-element').text('');
    var template = jQuery('#private-message-template').html();
    var html = Mustache.render(template, {
      text: message.message,
      from: message.user.name,
      createdAt: formattedTime,
    });
    jQuery('#private_messages_list').append(html);
    if (!calling) {
      privateScrollToBottom();
    }

    playNotificationSound();
    socket.emit('privateMessageSendSuccessful', {
      message: message.message,
      userid: slice_id,
    });
  } else {
    playNotificationSound();
    socket.emit('privateMessageSendSuccessful', {
      message: message.message,
      userid: message.user.id,
    });
    incrementUnreadBadge(message.user.id);
  }
});

socket.on('privateMessageSuccessfulAdd', function (message) {
  var formattedTime = moment(message.createdAt).format('h:mm a');
  var message_object = {
    text: message.message,
    from: message.user.name,
    createdAt: formattedTime,
    type: 'message',
  };
  add_message(message_object, message.id);

  if (getActivePrivateUserId() === message.id) {
    var template = jQuery('#private-message-template').html();
    var html = Mustache.render(template, {
      text: message.message,
      from: message.user.name,
      createdAt: formattedTime,
    });
    jQuery('#private_messages_list').append(html);
    if (!calling) {
      privateScrollToBottom();
    }
  }
});

socket.on('newLocationMessage', function (message) {
  appendRoomMessageItem(message);
});

jQuery('[name=message]').on('input', function () {
  socket.emit('typing:start');
  if (roomTypingStopTimeout) clearTimeout(roomTypingStopTimeout);
  roomTypingStopTimeout = setTimeout(function () {
    socket.emit('typing:stop');
  }, 1500);
});

$('[name=private-message]').on('input', function () {
  var targetId = getActivePrivateUserId();
  if (!targetId) return;
  socket.emit('private:typing', { userid: targetId, isTyping: true });
  if (privateTypingStopTimeout) clearTimeout(privateTypingStopTimeout);
  privateTypingStopTimeout = setTimeout(function () {
    socket.emit('private:typing', { userid: targetId, isTyping: false });
  }, 1500);
});

$('#private-message-form').on('submit', function (e) {
  e.preventDefault();
  var private_messageTextbox = $('[name=private-message]');
  var text = private_messageTextbox.val();
  var slice_id = getActivePrivateUserId();

  if (!text || !text.trim() || !slice_id) return;

  if (privateTypingStopTimeout) clearTimeout(privateTypingStopTimeout);
  socket.emit('private:typing', { userid: slice_id, isTyping: false });

  socket.emit('createPrivateMessage', {
    message: text,
    userid: slice_id,
  });
  private_messageTextbox.val('');
});

jQuery('#message-form').on('submit', function (e) {
  e.preventDefault();

  var messageTextbox = jQuery('[name=message]');
  var text = messageTextbox.val();
  if (!text || !text.trim()) return;

  if (roomTypingStopTimeout) clearTimeout(roomTypingStopTimeout);
  socket.emit('typing:stop');

  socket.emit(
    'createMessage',
    {
      text: text,
    },
    function () {
      messageTextbox.val('');
    }
  );
});

var locationButton = jQuery('#send-location');
locationButton.on('click', function () {
  if (!navigator.geolocation) {
    return alert('Geolocation not supported by your browser.');
  }

  locationButton.attr('disabled', 'disabled').text('Sending location...');

  navigator.geolocation.getCurrentPosition(
    function (position) {
      locationButton
        .removeAttr('disabled')
        .html('<i class="fa fa-map-marker"></i> <span>Send location</span>');
      socket.emit('createLocationMessage', {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });
    },
    function () {
      locationButton
        .removeAttr('disabled')
        .html('<i class="fa fa-map-marker"></i> <span>Send location</span>');
      alert('Unable to fetch location.');
    }
  );
});

var privatelocation = $('#private-send-location');
privatelocation.on('click', function () {
  if (!navigator.geolocation) {
    return alert('Geolocation not supported by your browser.');
  }
  var userid = getActivePrivateUserId();
  if (!userid) return;

  privatelocation.attr('disabled', 'disabled').text('Sending location...');

  navigator.geolocation.getCurrentPosition(
    function (position) {
      privatelocation
        .removeAttr('disabled')
        .html('<i class="fa fa-map-marker"></i> <span>Send location</span>');
      socket.emit('createPrivateLocationMessage', {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        userid: userid,
      });
    },
    function () {
      privatelocation
        .removeAttr('disabled')
        .html('<i class="fa fa-map-marker"></i> <span>Send location</span>');
      alert('Unable to fetch location.');
    }
  );
});

socket.on('newPrivateLocationMessage', function (message) {
  var formattedTime = moment(message.location.createdAt).format('h:mm a');
  var message_object = {
    from: message.location.from,
    url: message.location.url,
    createdAt: formattedTime,
    type: 'location',
  };
  add_message(message_object, message.user.id);

  var slice_user_id = getActivePrivateUserId();
  if (slice_user_id === message.user.id) {
    var template = jQuery('#location-message-template').html();
    var html = Mustache.render(template, {
      from: message.location.from,
      url: message.location.url,
      createdAt: formattedTime,
    });
    jQuery('#private_messages_list').append(html);
    if (!calling) {
      privateScrollToBottom();
    }

    playNotificationSound();
    socket.emit('locationMessageSuccessful', message);
  } else {
    playNotificationSound();
    socket.emit('locationMessageSuccessful', message);
    incrementUnreadBadge(message.user.id);
  }
});

socket.on('locationMessageSuccessful', function (message) {
  var formattedTime = moment(message.message.location.createdAt).format('h:mm a');
  var message_object = {
    from: message.message.location.from,
    url: message.message.location.url,
    createdAt: formattedTime,
    type: 'location',
  };
  add_message(message_object, message.id);

  if (getActivePrivateUserId() === message.id) {
    var template = jQuery('#location-message-template').html();
    var html = Mustache.render(template, {
      from: message.message.location.from,
      url: message.message.location.url,
      createdAt: formattedTime,
    });
    jQuery('#private_messages_list').append(html);
    if (!calling) {
      privateScrollToBottom();
    }
  }
});

socket.on('onAudioCall', function (arrayBuffer) {
  var blob = new Blob([arrayBuffer], { type: 'audio/ogg; codecs=opus' });
  calling_audio.src = window.URL.createObjectURL(blob);
});

$('#accept-call').on('click', function () {
  clearRingTimeout();
  var userid = caller_id || getActivePrivateUserId();
  socket.emit('callReceived', userid);
  $('#call-receive-section').addClass('accept-reject-call');
  $('#call-section').removeClass('end-call');

  $('#audio-call').attr('disabled', true);
  $('#video-call').attr('disabled', true);
  modal_close_button[0].setAttribute('disabled', 'disabled');

  $('#alert-box').addClass('alert-hide');
  calling = true;
  document.getElementById('audio-call-start').click();

  $('#show-time').removeClass('hide-time');
  document.getElementById('show-time').innerHTML = '00:00';
  $('#show-call-text').addClass('hide-time');
  stopCallTimer();
  callTimerTimeout = setTimeout(update, 1000);
});

$('#reject-call').on('click', function () {
  var userid = caller_id || getActivePrivateUserId();
  reject_call(userid);
});

function hide_receive_section(userid) {
  clearRingTimeout();
  ringTimeout = setTimeout(function () {
    if (!calling && caller_id === userid) {
      reject_call(userid);
    }
  }, 18000);
}

function reject_call(userid) {
  clearRingTimeout();
  if (userid) {
    socket.emit('callNotReceived', userid);
  }
  $('#call-receive-section').addClass('accept-reject-call');
  $('#audio-call').attr('disabled', false);
  $('#video-call').attr('disabled', false);
  modal_close_button[0].removeAttribute('disabled');
  $('#alert-box').addClass('alert-hide');
  caller_id = '';
}

$('#audio-call').on('click', function () {
  var userid = getActivePrivateUserId();
  if (!userid) return;
  socket.emit('initializeAudioCall', userid);
  $('#call-section').removeClass('end-call');
  $('#audio-call').attr('disabled', true);
  $('#video-call').attr('disabled', true);
  modal_close_button[0].setAttribute('disabled', 'disabled');
  calling = true;
  privateScrollToTop();
});

socket.on('incomingCall', function (user) {
  if (!user) return;
  if (!calling) {
    caller_id = user.id;
    document.getElementById('audio-calling-text').innerHTML = user.name + ' Calling......';
    playNotificationSound();

    var activeId = getActivePrivateUserId();
    if (activeId === '') {
      openPrivateModalForUser(user.id, user.name);
      $('#call-receive-section').removeClass('accept-reject-call');
      $('#audio-call').attr('disabled', true);
      $('#video-call').attr('disabled', true);
      modal_close_button[0].setAttribute('disabled', 'disabled');
    } else if (activeId !== user.id) {
      $('#alert-box').removeClass('alert-hide');
      document.getElementsByClassName('alert-text')[0].innerHTML =
        user.name + ' Calling... (Click to answer)';
    } else {
      $('#call-receive-section').removeClass('accept-reject-call');
      $('#audio-call').attr('disabled', true);
      $('#video-call').attr('disabled', true);
      modal_close_button[0].setAttribute('disabled', 'disabled');
    }

    hide_receive_section(user.id);
    privateScrollToTop();
  } else {
    socket.emit('userBusy', user.id);
  }
});

socket.on('userBusy', function () {
  end_call();
  alert('User is currently busy or on Do Not Disturb.');
});

$('#audio-call-start').on('click', function () {
  var constraints = { audio: true };
  var userid = getActivePrivateUserId() || caller_id;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then(function (mediaStream) {
      activeMediaStream = mediaStream;
      startPrivateSfuSession(userid, 'audio', mediaStream);
    })
    .catch(function (err) {
      console.error('Unable to access microphone:', err);
      end_call();
    });
});

$('#end-call').on('click', function () {
  var userid = getActivePrivateUserId() || caller_id;
  end_call();
  socket.emit('callEnded', userid);
  $('#show-time').addClass('hide-time');
  $('#show-call-text').removeClass('hide-time');
});

socket.on('callEnded', function () {
  end_call();
  $('#show-time').addClass('hide-time');
  $('#show-call-text').removeClass('hide-time');
});

function end_call() {
  calling = false;
  caller_id = '';
  clearRingTimeout();
  stopCallTimer();
  stopMediaStream();

  $('#audio-call').attr('disabled', false);
  $('#video-call').attr('disabled', false);
  modal_close_button[0].removeAttribute('disabled');
  $('#call-section').addClass('end-call');
  $('#call-receive-section').addClass('accept-reject-call');
  $('#alert-box').addClass('alert-hide');
}

socket.on('callNotReceived', function () {
  end_call();
});

socket.on('notifyCallReceived', function () {
  calling = true;
  document.getElementById('audio-call-start').click();

  $('#show-time').removeClass('hide-time');
  document.getElementById('show-time').innerHTML = '00:00';
  $('#show-call-text').addClass('hide-time');
  stopCallTimer();
  callTimerTimeout = setTimeout(update, 1000);
});

$('#show-people').on('click', function () {
  var chat_sidebar = document.getElementById('chat__sidebar');
  var show_people = document.getElementById('show-people');
  var change_arrow = document.getElementById('change-arrow');
  if ($('#chat__sidebar').hasClass('hide-show-people')) {
    chat_sidebar.classList.remove('hide-show-people');
    show_people.classList.remove('change-button-position');
    change_arrow.classList.add('fa-bars');
    change_arrow.classList.remove('fa-times');
  } else {
    chat_sidebar.classList.add('hide-show-people');
    show_people.classList.add('change-button-position');
    change_arrow.classList.remove('fa-bars');
    change_arrow.classList.add('fa-times');
  }
});

// 1-to-1 Video Call Section (powered by werift SFU)
$('#video-call').on('click', function () {
  var userid = getActivePrivateUserId();
  if (!userid) return;
  socket.emit('initializeVideoCall', userid);
  $('#video-call-section').removeClass('end-video-call');
  $('#audio-call').attr('disabled', true);
  $('#video-call').attr('disabled', true);
  modal_close_button[0].setAttribute('disabled', 'disabled');
  calling = true;
  privateScrollToTop();
});

socket.on('incomingVideoCall', function (user) {
  if (!user) return;
  if (!calling) {
    video_caller_id = user.id;
    document.getElementById('video-calling-text').innerHTML = user.name + ' Video Calling......';
    playNotificationSound();

    var activeId = getActivePrivateUserId();
    if (activeId === '') {
      openPrivateModalForUser(user.id, user.name);
      $('#video-call-receive-section').removeClass('accept-reject-video-call');
      $('#audio-call').attr('disabled', true);
      $('#video-call').attr('disabled', true);
      modal_close_button[0].setAttribute('disabled', 'disabled');
    } else if (activeId !== user.id) {
      $('#alert-box').removeClass('alert-hide');
      document.getElementsByClassName('alert-text')[0].innerHTML =
        user.name + ' Video Calling... (Click to answer)';
    } else {
      $('#video-call-receive-section').removeClass('accept-reject-video-call');
      $('#audio-call').attr('disabled', true);
      $('#video-call').attr('disabled', true);
      modal_close_button[0].setAttribute('disabled', 'disabled');
    }
    hide_video_section(user.id);
    privateScrollToTop();
  } else {
    socket.emit('userVideoBusy', user.id);
  }
});

socket.on('userVideoBusy', function () {
  end_video_call();
  alert('User is currently busy or on Do Not Disturb.');
});

$('#accept-video-call').on('click', function () {
  clearVideoRingTimeout();
  var userid = video_caller_id || getActivePrivateUserId();
  socket.emit('videoCallReceived', userid);
  $('#video-call-receive-section').addClass('accept-reject-video-call');
  $('#video-call-section').removeClass('end-video-call');

  $('#audio-call').attr('disabled', true);
  $('#video-call').attr('disabled', true);
  modal_close_button[0].setAttribute('disabled', 'disabled');

  $('#alert-box').addClass('alert-hide');
  calling = true;
  document.getElementById('video-call-start').click();

  $('#other-video').removeClass('other-video');
});

socket.on('notifyVideoCallReceived', function () {
  calling = true;
  document.getElementById('video-call-start').click();
  $('#other-video').removeClass('other-video');
});

$('#video-call-start').on('click', function () {
  var constraints = {
    audio: true,
    video: true,
  };
  var userid = getActivePrivateUserId() || video_caller_id;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then(function (mediaStream) {
      activeMediaStream = mediaStream;
      var selfVideo = document.getElementById('self-video');
      if (selfVideo) {
        selfVideo.srcObject = mediaStream;
        $('#self-video').removeClass('self-video');
      }

      startPrivateSfuSession(userid, 'video', mediaStream);
    })
    .catch(function (err) {
      console.error('Unable to access camera/microphone:', err);
      end_video_call();
    });
});

socket.on('onVideoCall', function (arrayBuffer) {
  var blob = new Blob([arrayBuffer], { type: 'video/webm; codecs=vp9' });
  document.getElementById('other-video').src = window.URL.createObjectURL(blob);
});

$('#reject-video-call').on('click', function () {
  var userid = video_caller_id || getActivePrivateUserId();
  reject_video_call(userid);
});

function hide_video_section(userid) {
  clearVideoRingTimeout();
  videoRingTimeout = setTimeout(function () {
    if (!calling && video_caller_id === userid) {
      reject_video_call(userid);
    }
  }, 18000);
}

function reject_video_call(userid) {
  clearVideoRingTimeout();
  if (userid) {
    socket.emit('videoCallNotReceived', userid);
  }
  $('#video-call-receive-section').addClass('accept-reject-video-call');
  $('#audio-call').attr('disabled', false);
  $('#video-call').attr('disabled', false);
  modal_close_button[0].removeAttribute('disabled');
  $('#alert-box').addClass('alert-hide');
  video_caller_id = '';
}

socket.on('videoCallNotReceived', function () {
  end_video_call();
});

function end_video_call() {
  calling = false;
  video_caller_id = '';
  clearVideoRingTimeout();
  stopCallTimer();
  stopMediaStream();

  $('#audio-call').attr('disabled', false);
  $('#video-call').attr('disabled', false);
  modal_close_button[0].removeAttribute('disabled');
  $('#video-call-section').addClass('end-video-call');
  $('#video-call-receive-section').addClass('accept-reject-video-call');
  $('#other-video').addClass('other-video');
  $('#alert-box').addClass('alert-hide');
}

$('#end-video-call').on('click', function () {
  var userid = getActivePrivateUserId() || video_caller_id;
  end_video_call();
  socket.emit('videoCallEnded', userid);
});

socket.on('videoCallEnded', function () {
  end_video_call();
});

function add_message(message, id) {
  if (!id) return;
  if (!(id in user_message_dictionary)) {
    user_message_dictionary[id] = [];
  }
  user_message_dictionary[id].push(message);
}
