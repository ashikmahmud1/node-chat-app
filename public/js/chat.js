/**
 * NexusChat — Enterprise Client Engine (jQuery 4.0.0 & Modern WebRTC SFU)
 */
$(function () {
  'use strict';

  if (typeof io === 'undefined') {
    console.error('Socket.IO client library is not loaded.');
    alert('Socket.IO client library failed to load. Please verify your connection to the server.');
    return;
  }

  var socket = io();

  // Helper: Get user initials (e.g. "Ashik Rahman" -> "AR", "Ashik" -> "AS")
  function getInitials(name) {
    if (!name || typeof name !== 'string') return '??';
    var parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    }
    var single = parts[0];
    if (single.length >= 2) {
      return single.slice(0, 2).toUpperCase();
    }
    return single.charAt(0).toUpperCase();
  }

  // Deterministic avatar gradient color generator based on username
  function getAvatarStyle(name) {
    var str = name || 'User';
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    var h1 = Math.abs(hash % 360);
    var h2 = (h1 + 45) % 360;
    return 'background: linear-gradient(135deg, hsl(' + h1 + ', 70%, 48%), hsl(' + h2 + ', 75%, 40%));';
  }

  function scrollToBottom(id) {
    var $messages = $(id);
    if (!$messages.length) return;
    var newMessage = $messages.children('li:last-child');
    if (!newMessage.length) return;

    var clientHeight = $messages.prop('clientHeight') || 0;
    var scrollTop = $messages.prop('scrollTop') || 0;
    var scrollHeight = $messages.prop('scrollHeight') || 0;
    var newMessageHeight = newMessage.innerHeight() || 0;
    var lastMessageHeight = newMessage.prev().innerHeight() || 0;

    if (clientHeight + scrollTop + newMessageHeight + lastMessageHeight >= scrollHeight - 120) {
      $messages.scrollTop(scrollHeight);
    }
  }

  // Call State
  var calling = false;
  var caller_id = '';
  var video_caller_id = '';
  var callTimerTimeout = null;
  var ringTimeout = null;
  var videoRingTimeout = null;
  var audio_message = null;
  var activeMediaStream = null;
  var activeMediaRecorder = null;

  // Active Canvas State ('group' or 'personal')
  var activeChatMode = 'group';
  var activePrivateUserId = '';
  var activePrivateUserName = '';

  // WebRTC SFU State
  var rtcIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  var currentRoomName = 'General';
  var currentUserName = 'Me';
  var currentUserStatus = 'online';
  var knownRoomsList = [];
  var groupUnreadCounts = {};
  var privateSfuSessionId = '';
  var privateSfuPc = null;
  var roomSfuSessionId = '';
  var roomSfuPc = null;
  var roomLocalStream = null;
  var roomScreenStream = null;
  var roomCallActive = false;
  var roomCallTimerTimeout = null;
  var roomTrackOwners = {};

  // Message Tracking, Deduplication & Typing
  var rendered_message_ids = {};
  var room_typing_users = {};
  var roomTypingStopTimeout = null;
  var privateTypingStopTimeout = null;
  var QUICK_REACTIONS = ['👍', '❤️', '🎉', '🚀', '👀'];

  // Personal message history & unread counters
  var user_message_dictionary = {};
  var unread_counts = {};
  var room_users_map = {};

  // Audio elements
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

  function getActivePrivateUserId() {
    return activeChatMode === 'personal' ? activePrivateUserId : '';
  }

  function updateUnreadBadgeDOM(userId) {
    var $badge = $('#users .new-message[data-user-id="' + userId + '"]');
    if (!$badge.length) return;
    var count = unread_counts[userId] || 0;
    if (count > 0) {
      $badge.css('display', 'inline-block').text(String(count));
    } else {
      $badge.css('display', 'none').text('');
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

  function incrementGroupUnreadBadge(roomName) {
    if (!roomName) return;
    groupUnreadCounts[roomName] = (groupUnreadCounts[roomName] || 0) + 1;
    renderGroupsSidebar();
  }

  function clearGroupUnreadBadge(roomName) {
    if (!roomName) return;
    groupUnreadCounts[roomName] = 0;
    renderGroupsSidebar();
  }

  function updateSidebarActiveHighlights() {
    $('#groups-list li.group-item').removeClass('active-chat-item');
    $('#users li.user-list').removeClass('active-chat-item');

    if (activeChatMode === 'group') {
      $('#groups-list li.group-item[data-room="' + currentRoomName + '"]').addClass('active-chat-item');
    } else if (activeChatMode === 'personal' && activePrivateUserId) {
      $('#users li.user-list[data-user-id="' + activePrivateUserId + '"]').addClass('active-chat-item');
    }
  }

  function updateEmptyStates() {
    var groupCount = $('#messages li.message').length;
    if (groupCount === 0) {
      $('#group-empty-title').text('Welcome to #' + currentRoomName + '!');
      $('#group-empty-desc').text('This is the start of the #' + currentRoomName + ' channel. Share messages, files, and start audio/video calls with your team.');
      $('#group-empty-state').removeClass('hide-element');
    } else {
      $('#group-empty-state').addClass('hide-element');
    }

    if (activeChatMode === 'personal' && activePrivateUserId) {
      var personalMsgs = user_message_dictionary[activePrivateUserId] || [];
      if (personalMsgs.length === 0) {
        $('#personal-empty-title').text('Direct Message with ' + activePrivateUserName);
        $('#personal-empty-desc').text('This is the start of your direct conversation with ' + activePrivateUserName + '. Messages sent here are 1-to-1 and private.');
        $('#personal-empty-state').removeClass('hide-element');
      } else {
        $('#personal-empty-state').addClass('hide-element');
      }
    }
  }

  /* ==========================================================================
     Sidebar Rendering: Top Half (Groups) & Bottom Half (Direct Messages)
     ========================================================================== */

  function ensureRoomInKnownList(roomName) {
    if (!roomName) return;
    var exists = knownRoomsList.some(function (r) {
      return r.toLowerCase() === roomName.toLowerCase();
    });
    if (!exists) {
      knownRoomsList.push(roomName);
    }
  }

  function renderGroupsSidebar() {
    ensureRoomInKnownList(currentRoomName);
    var $container = $('#groups-list');
    if (!$container.length) return;

    var filterQuery = ($('#quick-group-input').val() || '').trim().toLowerCase();
    var $ol = $('<ol></ol>');
    $('#groups-count').text(String(knownRoomsList.length));

    knownRoomsList.forEach(function (roomName) {
      if (filterQuery && roomName.toLowerCase().indexOf(filterQuery) === -1) {
        return;
      }

      var isCurrentJoined = roomName.toLowerCase() === currentRoomName.toLowerCase();
      var isActiveCanvas = activeChatMode === 'group' && isCurrentJoined;

      var $li = $('<li class="group-item"></li>').attr('data-room', roomName);
      if (isActiveCanvas) {
        $li.addClass('active-chat-item');
      }

      var $nameWrap = $('<div class="group-item__name"></div>');
      $nameWrap.append('<i class="fa-solid fa-hashtag group-item__icon" aria-hidden="true"></i>');
      $nameWrap.append($('<span></span>').text(roomName));

      var $metaWrap = $('<div class="group-item__meta"></div>');
      if (isCurrentJoined) {
        $metaWrap.append('<span class="group-joined-pill">Joined</span>');
      }

      var unread = groupUnreadCounts[roomName] || 0;
      var $unreadBadge = $('<span class="group-unread-badge"></span>');
      if (unread > 0) {
        $unreadBadge.css('display', 'inline-block').text(String(unread));
      }
      $metaWrap.append($unreadBadge);

      $li.append($nameWrap).append($metaWrap);
      $li.on('click', function (e) {
        e.preventDefault();
        selectGroupFromSidebar(roomName);
      });

      $ol.append($li);
    });

    $container.empty().append($ol);
  }

  function selectGroupFromSidebar(targetRoom) {
    if (!targetRoom) return;

    if (targetRoom.toLowerCase() === currentRoomName.toLowerCase()) {
      switchToGroupChatCanvas();
      return;
    }

    if (roomCallActive) {
      leaveRoomSfuCall();
    }

    socket.emit('room:switch', { room: targetRoom }, function (err, res) {
      if (err) {
        alert(err);
        return;
      }
      var canonical = (res && res.room) || targetRoom;
      currentRoomName = canonical;
      ensureRoomInKnownList(currentRoomName);
      try {
        if (window.sessionStorage) sessionStorage.setItem('nexus_room', currentRoomName);
        if (window.localStorage) localStorage.setItem('nexus_room', currentRoomName);
      } catch (e) {}

      rendered_message_ids = {};
      room_typing_users = {};
      updateRoomTypingBanner();
      $('#messages').empty();

      if (window.history && window.history.replaceState) {
        var newUrl =
          window.location.pathname +
          '?name=' +
          encodeURIComponent(currentUserName) +
          '&room=' +
          encodeURIComponent(currentRoomName);
        window.history.replaceState(null, '', newUrl);
      }

      switchToGroupChatCanvas();
      socket.emit('sfu:get-room-status', { room: currentRoomName }, function (statusRes) {
        if (statusRes && Array.isArray(statusRes.participants) && statusRes.participants.length > 0) {
          $('#room-call-count').text(String(statusRes.participants.length));
          $('#room-call-active-badge').removeClass('hide-element');
        } else {
          $('#room-call-active-badge').addClass('hide-element');
        }
      });
    });
  }

  $('#quick-group-form').on('submit', function (e) {
    e.preventDefault();
    var $input = $('#quick-group-input');
    var targetRoom = ($input.val() || '').trim();
    if (!targetRoom) return;
    $input.val('');
    ensureRoomInKnownList(targetRoom);
    selectGroupFromSidebar(targetRoom);
  });

  $('#quick-group-btn').on('click', function (e) {
    e.preventDefault();
    $('#quick-group-form').trigger('submit');
  });

  $('#quick-group-input').on('input', function () {
    renderGroupsSidebar();
  });

  /* ==========================================================================
     Canvas Switching (Group Chat vs Personal Chat)
     ========================================================================== */

  function switchToGroupChatCanvas() {
    activeChatMode = 'group';
    activePrivateUserId = '';
    activePrivateUserName = '';

    clearGroupUnreadBadge(currentRoomName);

    // Update Header for Group Mode
    $('#header-context-avatar')
      .removeClass('header-context-avatar--personal')
      .addClass('header-context-avatar--group')
      .attr('style', '');
    $('#header-context-initials').html('<i class="fa-solid fa-hashtag" aria-hidden="true"></i>');
    $('#header-avatar-status-dot').addClass('hide-element');

    $('#header-room-title').text('# ' + currentRoomName);
    $('#sidebar-room-name').text('# ' + currentRoomName);
    $('#header-status-dot').attr('class', 'room-status-dot status-online');
    $('#header-chat-subtitle').text('Group Channel · WebRTC SFU Enabled');
    $('#back-to-group-btn').addClass('hide-element');

    // Toggle Header Call Action Buttons
    $('#group-header-call-actions').removeClass('hide-element');
    $('#personal-header-call-actions').addClass('hide-element');

    // Toggle Canvas Views
    $('#personal-chat-canvas').addClass('hide-element');
    $('#group-chat-canvas').removeClass('hide-element');

    updateSidebarActiveHighlights();
    updateEmptyStates();
    applySearchFilter();

    var $msgList = $('#messages');
    if ($msgList.length) {
      $msgList.scrollTop($msgList.prop('scrollHeight') || 0);
    }
  }

  function switchToPersonalChatCanvas(userId, userName) {
    if (!userId || userId === socket.id) return;

    var peerUser = room_users_map[userId];
    var resolvedName = userName || (peerUser && peerUser.name) || 'Personal Chat';
    var peerStatus = (peerUser && peerUser.status) || 'online';
    var statusLabel =
      peerStatus === 'dnd' ? 'Do Not Disturb' : peerStatus === 'away' ? 'Away' : 'Active Now';

    activeChatMode = 'personal';
    activePrivateUserId = userId;
    activePrivateUserName = resolvedName;

    $('#private-typing-indicator').addClass('hide-element').text('');
    clearUnreadBadge(userId);

    // Update Header for Personal Mode
    $('#header-context-avatar')
      .removeClass('header-context-avatar--group')
      .addClass('header-context-avatar--personal')
      .attr('style', getAvatarStyle(resolvedName));
    $('#header-context-initials').text(getInitials(resolvedName));
    $('#header-avatar-status-dot')
      .removeClass('hide-element')
      .attr('class', 'header-avatar-status-dot status-' + peerStatus);

    $('#header-room-title').text(resolvedName);
    $('#header-status-dot').attr('class', 'room-status-dot status-' + peerStatus);
    $('#header-chat-subtitle').text('Direct Message · ' + statusLabel);
    $('#back-to-group-label').text('Back to #' + currentRoomName);
    $('#back-to-group-btn').removeClass('hide-element');

    // Toggle Header Call Buttons
    $('#group-header-call-actions').addClass('hide-element');
    $('#personal-header-call-actions').removeClass('hide-element');

    // Toggle Canvas Views
    $('#group-chat-canvas').addClass('hide-element');
    $('#personal-chat-canvas').removeClass('hide-element');

    renderPrivateMessages(userId);
    updateSidebarActiveHighlights();
    updateEmptyStates();
    applySearchFilter();

    // Close mobile sidebar if open
    if ($('#chat__sidebar').hasClass('hide-show-people')) {
      $('#chat__sidebar').removeClass('hide-show-people');
      $('#show-people').removeClass('change-button-position');
      $('#change-arrow').removeClass('fa-xmark').addClass('fa-bars');
    }
  }

  $('#back-to-group-btn').on('click', function (e) {
    e.preventDefault();
    switchToGroupChatCanvas();
  });

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
     WebRTC SFU Client Engine (1-to-1 Calls & Multi-User Room Calls)
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
        console.error('Personal SFU error:', err);
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
      badge.innerHTML = '<i class="fa-solid fa-user" aria-hidden="true"></i> <span></span>';
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
        console.error('Failed to join Room call:', err);
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
  $('#join-room-audio-btn').on('click', function (e) {
    e.preventDefault();
    joinRoomSfuCall('audio');
  });

  $('#join-room-video-btn').on('click', function (e) {
    e.preventDefault();
    joinRoomSfuCall('video');
  });

  $('#room-leave-call').on('click', function (e) {
    e.preventDefault();
    leaveRoomSfuCall();
  });

  $('#room-toggle-screen').on('click', function (e) {
    e.preventDefault();
    toggleRoomScreenShare();
  });

  $('#room-toggle-mic').on('click', function (e) {
    e.preventDefault();
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

  $('#room-toggle-cam').on('click', function (e) {
    e.preventDefault();
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
    currentUserStatus = status;
    $('#current-user-status-dot').attr('class', 'user-avatar-status-dot status-' + status);
    socket.emit('presence:update', { status: status });
  });

  // Live Message Search Filter
  function applySearchFilter() {
    var query = ($('#room-message-search').val() || '').trim().toLowerCase();
    if (query) {
      $('#clear-search-btn').removeClass('hide-element');
    } else {
      $('#clear-search-btn').addClass('hide-element');
    }

    var targetSelector =
      activeChatMode === 'personal' ? '#private_messages_list li.message' : '#messages li.message';

    $(targetSelector).each(function () {
      var $li = $(this);
      var textContent = ($li.text() || '').toLowerCase();
      if (!query || textContent.indexOf(query) !== -1) {
        $li.show();
      } else {
        $li.hide();
      }
    });
  }

  $('#room-message-search').on('input', applySearchFilter);

  $('#clear-search-btn').on('click', function (e) {
    e.preventDefault();
    $('#room-message-search').val('').trigger('input').trigger('focus');
  });

  // Personal Call Mic/Cam Controls
  $('#private-toggle-mic-audio, #private-toggle-mic-video').on('click', function (e) {
    e.preventDefault();
    if (!activeMediaStream) return;
    var audioTracks = activeMediaStream.getAudioTracks();
    if (!audioTracks.length) return;
    var enabled = !audioTracks[0].enabled;
    audioTracks.forEach(function (t) {
      t.enabled = enabled;
    });
    $(this).toggleClass('btn-warning', !enabled);
  });

  $('#private-toggle-cam-video').on('click', function (e) {
    e.preventDefault();
    if (!activeMediaStream) return;
    var videoTracks = activeMediaStream.getVideoTracks();
    if (!videoTracks.length) return;
    var enabled = !videoTracks[0].enabled;
    videoTracks.forEach(function (t) {
      t.enabled = enabled;
    });
    $(this).toggleClass('btn-warning', !enabled);
  });

  function renderPrivateMessages(userId) {
    var $list = $('#private_messages_list');
    $list.empty();

    var messages = user_message_dictionary[userId] || [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var isMine = msg.from === currentUserName;
      var initials = getInitials(msg.from);
      var avatarStyle = getAvatarStyle(msg.from);
      var extraClass = isMine ? 'message--outgoing' : 'message--incoming';
      var template;
      var html;

      if (msg.type === 'location') {
        template = $('#location-message-template').html();
        html = Mustache.render(template, {
          from: msg.from,
          url: msg.url,
          createdAt: msg.createdAt,
          initials: initials,
          extraClass: extraClass,
        });
      } else if (msg.type === 'file') {
        template = $('#file-message-template').html();
        html = Mustache.render(template, {
          from: msg.from,
          url: msg.url,
          filename: msg.url,
          createdAt: msg.createdAt,
          initials: initials,
          extraClass: extraClass,
        });
      } else {
        template = $('#private-message-template').html();
        html = Mustache.render(template, {
          text: msg.text,
          from: msg.from,
          createdAt: msg.createdAt,
          initials: initials,
          extraClass: extraClass,
        });
      }
      var $item = $(html);
      $item.find('.message__avatar').attr('style', avatarStyle);
      $list.append($item);
    }
    if (!calling) {
      $list.scrollTop($list.prop('scrollHeight') || 0);
    }
    updateEmptyStates();
  }

  $('#alert-box').on('click', function (e) {
    e.preventDefault();
    var pendingCallerId = caller_id || video_caller_id;
    if (!pendingCallerId || !room_users_map[pendingCallerId]) return;
    var callerUser = room_users_map[pendingCallerId];
    switchToPersonalChatCanvas(callerUser.id, callerUser.name);
    $('#alert-box').addClass('alert-hide');

    if (caller_id === pendingCallerId) {
      document.getElementById('audio-calling-text').innerHTML = callerUser.name + ' Calling...';
      $('#call-receive-section').removeClass('accept-reject-call');
      $('#audio-call').prop('disabled', true);
      $('#video-call').prop('disabled', true);
    } else if (video_caller_id === pendingCallerId) {
      document.getElementById('video-calling-text').innerHTML = callerUser.name + ' Video Calling...';
      $('#video-call-receive-section').removeClass('accept-reject-video-call');
      $('#audio-call').prop('disabled', true);
      $('#video-call').prop('disabled', true);
    }
  });

  // Reactions & message toolbar builder
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
      $btn.on('click', function (e) {
        e.preventDefault();
        socket.emit('message:reaction', {
          messageId: messageId,
          emoji: emoji,
        });
      });
      $bar.append($btn);
    });
  }

  function appendRoomMessageItem(message, isHistoryReplay) {
    if (!message) return;
    if (message.id && rendered_message_ids[message.id]) return;
    if (message.id) {
      rendered_message_ids[message.id] = true;
    }

    var formattedTime = moment(message.createdAt).format('h:mm a');
    var isMine = message.from === currentUserName;
    var initials = getInitials(message.from);
    var avatarStyle = getAvatarStyle(message.from);
    var extraClass = isMine ? 'message--mine' : '';
    var template;
    var html;
    var isTextMessage = false;

    if (message.type === 'location' || (message.url && message.url.indexOf('google.com/maps') !== -1)) {
      template = $('#location-message-template').html();
      html = Mustache.render(template, {
        from: message.from,
        url: message.url,
        createdAt: formattedTime,
        initials: initials,
        extraClass: extraClass,
      });
    } else if (message.type === 'file' || message.fileUrl || message.fileurl) {
      var fileUrl = message.fileUrl || message.fileurl || message.url;
      template = $('#file-message-template').html();
      html = Mustache.render(template, {
        from: message.from,
        url: fileUrl,
        filename: fileUrl,
        createdAt: formattedTime,
        initials: initials,
        extraClass: extraClass,
      });
    } else {
      isTextMessage = true;
      template = $('#message-template').html();
      html = Mustache.render(template, {
        text: message.text,
        from: message.from,
        createdAt: formattedTime,
        initials: initials,
        extraClass: extraClass,
      });
    }

    var $li = $(html);
    $li.find('.message__avatar').attr('style', avatarStyle);
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
            '<button type="button" class="msg-action-btn" title="Edit message"><i class="fa-solid fa-pen"></i></button>'
          );
          $editBtn.on('click', function (e) {
            e.preventDefault();
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
          '<button type="button" class="msg-action-btn msg-action-delete" title="Delete message"><i class="fa-solid fa-trash-can"></i></button>'
        );
        $delBtn.on('click', function (e) {
          e.preventDefault();
          socket.emit('message:delete', { messageId: message.id });
        });
        $ownerActions.append($delBtn);
        $toolbar.append($ownerActions);
      }

      $li.append($toolbar);
      renderMessageReactions($li, message.id, message.reactions);
    }

    $('#messages').append($li);
    updateEmptyStates();

    if (activeChatMode === 'group') {
      scrollToBottom('#messages');
    } else if (!isHistoryReplay && message.from !== 'Admin' && message.from !== currentUserName) {
      incrementGroupUnreadBadge(currentRoomName);
      playNotificationSound();
    }
  }

  socket.on('roomHistory', function (messages) {
    if (!Array.isArray(messages)) return;
    messages.forEach(function (msg) {
      appendRoomMessageItem(msg, true);
    });
    updateEmptyStates();
  });

  socket.on('updateRoomList', function (rooms) {
    if (!Array.isArray(rooms)) return;
    rooms.forEach(function (r) {
      ensureRoomInKnownList(r);
    });
    renderGroupsSidebar();
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
    updateEmptyStates();
  });

  socket.on('message:reaction-updated', function (data) {
    if (!data || !data.messageId) return;
    var $li = $('#messages li.message[data-message-id="' + data.messageId + '"]');
    if (!$li.length) return;
    renderMessageReactions($li, data.messageId, data.reactions);
  });

  function updateRoomTypingBanner() {
    var names = Object.keys(room_typing_users).map(function (uid) {
      return room_typing_users[uid];
    });
    var $banner = $('#room-typing-indicator');
    if (names.length === 0) {
      $banner.addClass('hide-element').empty();
    } else {
      var text = names.length === 1 ? names[0] + ' is typing...' : names.join(', ') + ' are typing...';
      $banner
        .removeClass('hide-element')
        .html('<span class="typing-dots"><span></span><span></span><span></span></span> ' + $('<div>').text(text).html());
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
      $indicator
        .removeClass('hide-element')
        .html('<span class="typing-dots"><span></span><span></span><span></span></span> ' + $('<div>').text(data.name + ' is typing...').html());
    } else {
      $indicator.addClass('hide-element').empty();
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
      renderPrivateMessages(slice_user_id);
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
      renderPrivateMessages(info.id);
    }
  });

  socket.on('newFileMessage', function (message) {
    appendRoomMessageItem(message, false);
  });

  function uploadFile(fileEl, isPrivateUpload) {
    if (!fileEl || !fileEl.files || !fileEl.files[0]) return;

    var formData = new FormData();
    formData.append('file', fileEl.files[0]);

    var progressEl = document.getElementById(isPrivateUpload ? 'private-upload-progress-bar' : 'upload-progress-bar');
    var progressInner = document.getElementById(isPrivateUpload ? 'private-upload-progress-bar-inner' : 'upload-progress-bar-inner');

    $.ajax({
      url: '/upload',
      type: 'POST',
      data: formData,
      processData: false,
      contentType: false,
      xhr: function () {
        var xhr = new window.XMLHttpRequest();
        if (progressEl) {
          progressEl.classList.remove('progress-hide');
          progressEl.classList.remove('private-progress-hide');
        }

        xhr.upload.addEventListener('progress', function (e) {
          if (e.lengthComputable && progressInner) {
            var percent = (e.loaded / e.total) * 100;
            progressInner.style.width = percent + '%';
            progressInner.textContent = percent.toFixed(0) + '%';
          }
        });

        return xhr;
      },
      success: function (fileData) {
        var fileInfo = fileData.file;
        if (!fileInfo) return;

        if (!isPrivateUpload) {
          socket.emit('newFileMessage', fileInfo);
        } else {
          var userid = getActivePrivateUserId();
          if (userid) {
            socket.emit('newPrivateFileMessage', {
              fileInfo: fileInfo,
              userid: userid,
            });
          }
        }
      },
      error: function (xhr) {
        var errMsg =
          (xhr && xhr.responseJSON && xhr.responseJSON.error) ||
          'Failed to upload file. Please try again.';
        alert(errMsg);
      },
      complete: function () {
        if (progressEl) {
          progressEl.classList.add('progress-hide');
          progressEl.classList.add('private-progress-hide');
        }
        fileEl.value = '';
      },
    });
  }

  $('#input-file').on('change', function (event) {
    if (!event.target.files || !event.target.files[0]) return;
    uploadFile(document.getElementById('input-file'), false);
  });

  $('#private-send-file').on('change', function (event) {
    if (!event.target.files || !event.target.files[0]) return;
    uploadFile(document.getElementById('private-send-file'), true);
  });

  $('#send-file').on('click', function (e) {
    e.preventDefault();
    var el = document.getElementById('input-file');
    if (el) el.click();
  });

  $('#private-send-file-click').on('click', function (e) {
    e.preventDefault();
    var el = document.getElementById('private-send-file');
    if (el) el.click();
  });

  // Client Session Bootstrap & Persistence
  function resolveJoinParameters() {
    var params = jQuery.deparam(window.location.search);
    var storedName = '';
    var storedRoom = '';

    try {
      storedName =
        (window.sessionStorage && sessionStorage.getItem('nexus_name')) ||
        (window.localStorage && localStorage.getItem('nexus_name')) ||
        '';
      storedRoom =
        (window.sessionStorage && sessionStorage.getItem('nexus_room')) ||
        (window.localStorage && localStorage.getItem('nexus_room')) ||
        '';
    } catch (e) {}

    var name = (params && params.name && params.name.trim()) || storedName.trim();
    var room = (params && params.room && params.room.trim()) || storedRoom.trim();

    if (!name) {
      name = 'Ashik';
    }
    if (!room) {
      room = 'General';
    }

    try {
      if (window.sessionStorage) {
        sessionStorage.setItem('nexus_name', name);
        sessionStorage.setItem('nexus_room', room);
      }
      if (window.localStorage) {
        localStorage.setItem('nexus_name', name);
        localStorage.setItem('nexus_room', room);
      }
    } catch (e) {}

    if (window.history && window.history.replaceState) {
      var fullUrl =
        window.location.pathname +
        '?name=' +
        encodeURIComponent(name) +
        '&room=' +
        encodeURIComponent(room);
      window.history.replaceState(null, '', fullUrl);
    }

    return { name: name, room: room };
  }

  socket.on('connect', function () {
    $('#connection-status-text').text('Connected');
    $('.status-pulse-dot').removeClass('status-pulse-dot--disconnected');

    var params = resolveJoinParameters();
    currentRoomName = params.room;
    currentUserName = params.name;
    ensureRoomInKnownList(currentRoomName);

    $('#header-room-title').text('# ' + currentRoomName);
    $('#sidebar-room-name').text('# ' + currentRoomName);
    $('#current-user-name').text(currentUserName);
    $('#current-user-avatar').text(getInitials(currentUserName)).attr('style', getAvatarStyle(currentUserName));
    renderGroupsSidebar();

    socket.emit('join', params, function (err) {
      if (err) {
        // If name is taken in this room, append friendly numeric suffix instead of crashing
        params.name = params.name + '_' + Math.floor(100 + Math.random() * 900);
        currentUserName = params.name;
        $('#current-user-name').text(currentUserName);
        $('#current-user-avatar').text(getInitials(currentUserName)).attr('style', getAvatarStyle(currentUserName));
        socket.emit('join', params, function () {});
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

  socket.on('disconnect', function () {
    $('#connection-status-text').text('Reconnecting...');
    $('.status-pulse-dot').addClass('status-pulse-dot--disconnected');
  });

  function openPersonalChatForPeer(id) {
    if (!id || id === socket.id) return;
    var targetUser = room_users_map[id];
    var targetName = targetUser ? targetUser.name : 'Personal Chat';

    switchToPersonalChatCanvas(id, targetName);

    if (caller_id === id) {
      document.getElementById('audio-calling-text').innerHTML = targetName + ' Calling...';
      $('#call-receive-section').removeClass('accept-reject-call');
      $('#alert-box').addClass('alert-hide');
    }
    if (video_caller_id === id) {
      document.getElementById('video-calling-text').innerHTML = targetName + ' Video Calling...';
      $('#video-call-receive-section').removeClass('accept-reject-video-call');
      $('#alert-box').addClass('alert-hide');
    }

    socket.emit('privateMessageWindow', { id: id });
  }

  socket.on('updateUserList', function (users) {
    var userfound = false;
    var activePrivateId = getActivePrivateUserId();
    var $ol = $('<ol></ol>');
    room_users_map = {};

    $('#online-count').text(String(users.length));

    users.forEach(function (user) {
      room_users_map[user.id] = user;
      if (user.id === socket.id && user.room) {
        currentRoomName = user.room;
        currentUserName = user.name;
        ensureRoomInKnownList(currentRoomName);
        $('#sidebar-room-name').text('# ' + user.room);
        if (activeChatMode === 'group') {
          $('#header-room-title').text('# ' + user.room);
        }
      }

      var isSelf = user.id === socket.id;
      var status = user.status || 'online';
      var statusLabel = status === 'dnd' ? 'Do Not Disturb' : status === 'away' ? 'Away' : 'Online';
      var displayName = isSelf ? user.name + ' (You)' : user.name;
      var avatarStyle = getAvatarStyle(user.name);
      var initials = getInitials(user.name);

      var $list = $('<li class="user-list"></li>').attr('data-user-id', user.id);
      if (isSelf) {
        $list.addClass('user-list--self');
      } else if (activeChatMode === 'personal' && activePrivateId === user.id) {
        $list.addClass('active-chat-item');
      }

      var $avatarWrap = $('<div class="sidebar-item-avatar-wrap"></div>');
      var $avatar = $('<div class="user-avatar-badge user-avatar-badge--sm"></div>')
        .attr('style', avatarStyle)
        .text(initials);
      var $dot = $('<span class="user-avatar-status-dot status-' + status + '"></span>');
      $avatarWrap.append($avatar).append($dot);

      var $infoWrap = $('<div class="user-list__name"></div>');
      $infoWrap.append($('<span class="user-primary-name"></span>').text(displayName));
      $infoWrap.append($('<span class="user-secondary-status"></span>').text(statusLabel));

      var $row = $('<div class="user-row-flex"></div>').append($avatarWrap).append($infoWrap);
      $list.append($row);

      if (!isSelf) {
        var $actionsWrap = $('<div class="user-list__actions"></div>');
        var $badge = $('<span class="new-message"></span>').attr('data-user-id', user.id);
        var unread = unread_counts[user.id] || 0;
        if (unread > 0) {
          $badge.css('display', 'inline-block').text(String(unread));
        }

        var $chatBtn = $('<button type="button" class="btn-chat-trigger" title="Message User"><i class="fa-regular fa-comment-dots" aria-hidden="true"></i></button>');
        $actionsWrap.append($badge).append($chatBtn);
        $list.append($actionsWrap);

        $list.on('click', function (e) {
          e.preventDefault();
          openPersonalChatForPeer(user.id);
        });
      }

      $ol.append($list);

      if (activePrivateId && activePrivateId === user.id) {
        userfound = true;
        $('#header-status-dot').attr('class', 'room-status-dot status-' + status);
        $('#header-avatar-status-dot').attr('class', 'header-avatar-status-dot status-' + status);
        $('#header-chat-subtitle').text('Direct Message · ' + (status === 'dnd' ? 'Do Not Disturb' : status === 'away' ? 'Away' : 'Active Now'));
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
      switchToGroupChatCanvas();
    }

    $('#users').empty().append($ol);
    renderGroupsSidebar();
  });

  socket.on('notifyUser', function (data) {
    if (!data || !data.user) return;
    socket.emit('private_connection_successful', {
      user: data.user,
      otherUserId: data.otherUser,
    });
  });

  socket.on('openChatWindow', function () {});

  socket.on('newMessage', function (message) {
    appendRoomMessageItem(message, false);
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
      $('#private-typing-indicator').addClass('hide-element').empty();
      renderPrivateMessages(slice_id);
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
      renderPrivateMessages(message.id);
    }
  });

  socket.on('newLocationMessage', function (message) {
    appendRoomMessageItem(message, false);
  });

  $('#message-input').on('input', function () {
    socket.emit('typing:start');
    if (roomTypingStopTimeout) clearTimeout(roomTypingStopTimeout);
    roomTypingStopTimeout = setTimeout(function () {
      socket.emit('typing:stop');
    }, 1500);
  });

  $('#private-message-input').on('input', function () {
    var targetId = getActivePrivateUserId();
    if (!targetId) return;
    socket.emit('private:typing', { userid: targetId, isTyping: true });
    if (privateTypingStopTimeout) clearTimeout(privateTypingStopTimeout);
    privateTypingStopTimeout = setTimeout(function () {
      socket.emit('private:typing', { userid: targetId, isTyping: false });
    }, 1500);
  });

  // Group Message Dispatch
  function submitGroupMessage() {
    var $input = $('#message-input');
    var text = ($input.val() || '').trim();
    if (!text) return;

    $input.val('').trigger('focus');

    if (roomTypingStopTimeout) clearTimeout(roomTypingStopTimeout);
    socket.emit('typing:stop');

    socket.emit('createMessage', { text: text }, function () {});
  }

  $('#message-input').on('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitGroupMessage();
    }
  });

  $('#message-form').on('submit', function (e) {
    e.preventDefault();
    submitGroupMessage();
  });

  $('#group-send-btn').on('click', function (e) {
    e.preventDefault();
    submitGroupMessage();
  });

  // Personal Message Dispatch
  function submitPrivateMessage() {
    var $input = $('#private-message-input');
    var text = ($input.val() || '').trim();
    var targetId = getActivePrivateUserId();
    if (!text || !targetId) return;

    $input.val('').trigger('focus');

    if (privateTypingStopTimeout) clearTimeout(privateTypingStopTimeout);
    socket.emit('private:typing', { userid: targetId, isTyping: false });

    socket.emit('createPrivateMessage', {
      message: text,
      userid: targetId,
    });
  }

  $('#private-message-input').on('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitPrivateMessage();
    }
  });

  $('#private-message-form').on('submit', function (e) {
    e.preventDefault();
    submitPrivateMessage();
  });

  $('#private-send-btn').on('click', function (e) {
    e.preventDefault();
    submitPrivateMessage();
  });

  // Geolocation Dispatchers
  $('#send-location').on('click', function (e) {
    e.preventDefault();
    if (!navigator.geolocation) {
      return alert('Geolocation is not supported by your browser.');
    }
    var $btn = $(this);
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> <span>Locating...</span>');

    navigator.geolocation.getCurrentPosition(
      function (position) {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-location-dot"></i> <span>Location</span>');
        socket.emit('createLocationMessage', {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      function () {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-location-dot"></i> <span>Location</span>');
        alert('Unable to fetch location.');
      }
    );
  });

  $('#private-send-location').on('click', function (e) {
    e.preventDefault();
    if (!navigator.geolocation) {
      return alert('Geolocation is not supported by your browser.');
    }
    var targetId = getActivePrivateUserId();
    if (!targetId) return;

    var $btn = $(this);
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> <span>Locating...</span>');

    navigator.geolocation.getCurrentPosition(
      function (position) {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-location-dot"></i> <span>Location</span>');
        socket.emit('createPrivateLocationMessage', {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          userid: targetId,
        });
      },
      function () {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-location-dot"></i> <span>Location</span>');
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
      renderPrivateMessages(slice_user_id);
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
      renderPrivateMessages(message.id);
    }
  });

  socket.on('onAudioCall', function (arrayBuffer) {
    var blob = new Blob([arrayBuffer], { type: 'audio/ogg; codecs=opus' });
    calling_audio.src = window.URL.createObjectURL(blob);
  });

  $('#accept-call').on('click', function (e) {
    e.preventDefault();
    clearRingTimeout();
    var userid = caller_id || getActivePrivateUserId();
    socket.emit('callReceived', userid);
    $('#call-receive-section').addClass('accept-reject-call');
    $('#call-section').removeClass('end-call');

    $('#audio-call').prop('disabled', true);
    $('#video-call').prop('disabled', true);

    $('#alert-box').addClass('alert-hide');
    calling = true;
    document.getElementById('audio-call-start').click();

    $('#show-time').removeClass('hide-time').text('00:00');
    $('#show-call-text').addClass('hide-time');
    stopCallTimer();
    callTimerTimeout = setTimeout(update, 1000);
  });

  $('#reject-call').on('click', function (e) {
    e.preventDefault();
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
    $('#audio-call').prop('disabled', false);
    $('#video-call').prop('disabled', false);
    $('#alert-box').addClass('alert-hide');
    caller_id = '';
  }

  $('#audio-call').on('click', function (e) {
    e.preventDefault();
    var userid = getActivePrivateUserId();
    if (!userid) return;
    socket.emit('initializeAudioCall', userid);
    $('#call-section').removeClass('end-call');
    $('#audio-call').prop('disabled', true);
    $('#video-call').prop('disabled', true);
    calling = true;
  });

  socket.on('incomingCall', function (user) {
    if (!user) return;
    if (!calling) {
      caller_id = user.id;
      document.getElementById('audio-calling-text').innerHTML = user.name + ' Calling...';
      playNotificationSound();

      var activeId = getActivePrivateUserId();
      if (activeId === user.id) {
        $('#call-receive-section').removeClass('accept-reject-call');
        $('#audio-call').prop('disabled', true);
        $('#video-call').prop('disabled', true);
      } else {
        $('#alert-box').removeClass('alert-hide');
        document.getElementsByClassName('alert-text')[0].innerHTML =
          user.name + ' Calling... (Click to answer)';
      }
      hide_receive_section(user.id);
    } else {
      socket.emit('userBusy', user.id);
    }
  });

  socket.on('userBusy', function () {
    end_call();
    alert('User is currently busy or on Do Not Disturb.');
  });

  $('#audio-call-start').on('click', function (e) {
    e.preventDefault();
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
        console.error('Microphone error:', err);
        end_call();
      });
  });

  $('#end-call').on('click', function (e) {
    e.preventDefault();
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

    $('#audio-call').prop('disabled', false);
    $('#video-call').prop('disabled', false);
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
    $('#show-time').removeClass('hide-time').text('00:00');
    $('#show-call-text').addClass('hide-time');
    stopCallTimer();
    callTimerTimeout = setTimeout(update, 1000);
  });

  $('#show-people').on('click', function (e) {
    e.preventDefault();
    var $sidebar = $('#chat__sidebar');
    var $btn = $(this);
    var $icon = $('#change-arrow');
    if ($sidebar.hasClass('hide-show-people')) {
      $sidebar.removeClass('hide-show-people');
      $btn.removeClass('change-button-position');
      $icon.removeClass('fa-xmark').addClass('fa-bars');
    } else {
      $sidebar.addClass('hide-show-people');
      $btn.addClass('change-button-position');
      $icon.removeClass('fa-bars').addClass('fa-xmark');
    }
  });

  // 1-to-1 Video Call
  $('#video-call').on('click', function (e) {
    e.preventDefault();
    var userid = getActivePrivateUserId();
    if (!userid) return;
    socket.emit('initializeVideoCall', userid);
    $('#video-call-section').removeClass('end-video-call');
    $('#audio-call').prop('disabled', true);
    $('#video-call').prop('disabled', true);
    calling = true;
  });

  socket.on('incomingVideoCall', function (user) {
    if (!user) return;
    if (!calling) {
      video_caller_id = user.id;
      document.getElementById('video-calling-text').innerHTML = user.name + ' Video Calling...';
      playNotificationSound();

      var activeId = getActivePrivateUserId();
      if (activeId === user.id) {
        $('#video-call-receive-section').removeClass('accept-reject-video-call');
        $('#audio-call').prop('disabled', true);
        $('#video-call').prop('disabled', true);
      } else {
        $('#alert-box').removeClass('alert-hide');
        document.getElementsByClassName('alert-text')[0].innerHTML =
          user.name + ' Video Calling... (Click to answer)';
      }
      hide_video_section(user.id);
    } else {
      socket.emit('userVideoBusy', user.id);
    }
  });

  socket.on('userVideoBusy', function () {
    end_video_call();
    alert('User is currently busy or on Do Not Disturb.');
  });

  $('#accept-video-call').on('click', function (e) {
    e.preventDefault();
    clearVideoRingTimeout();
    var userid = video_caller_id || getActivePrivateUserId();
    socket.emit('videoCallReceived', userid);
    $('#video-call-receive-section').addClass('accept-reject-video-call');
    $('#video-call-section').removeClass('end-video-call');

    $('#audio-call').prop('disabled', true);
    $('#video-call').prop('disabled', true);

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

  $('#video-call-start').on('click', function (e) {
    e.preventDefault();
    var constraints = { audio: true, video: true };
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
        console.error('Camera/mic error:', err);
        end_video_call();
      });
  });

  socket.on('onVideoCall', function (arrayBuffer) {
    var blob = new Blob([arrayBuffer], { type: 'video/webm; codecs=vp9' });
    document.getElementById('other-video').src = window.URL.createObjectURL(blob);
  });

  $('#reject-video-call').on('click', function (e) {
    e.preventDefault();
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
    $('#audio-call').prop('disabled', false);
    $('#video-call').prop('disabled', false);
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

    $('#audio-call').prop('disabled', false);
    $('#video-call').prop('disabled', false);
    $('#video-call-section').addClass('end-video-call');
    $('#video-call-receive-section').addClass('accept-reject-video-call');
    $('#other-video').addClass('other-video');
    $('#alert-box').addClass('alert-hide');
  }

  $('#end-video-call').on('click', function (e) {
    e.preventDefault();
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

  // Keyboard shortcut: Escape clears search or closes call stage
  $(document).on('keydown', function (e) {
    if (e.key === 'Escape') {
      if ($('#room-message-search').val()) {
        $('#clear-search-btn').click();
      }
    }
  });
});
