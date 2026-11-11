$(function () {
  'use strict';

  const socket = io({ autoConnect: false });
  const params = JSON.parse(sessionStorage.getItem('nexus_join') || 'null');
  if (!params?.name || !params?.room) {
    location.replace('/');
    return;
  }
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  let guestId;
  let ready = false;
  let switching = false;
  let historyLimit;

  function showError(message) {
    $('#alert-box').removeClass('alert-hide').find('.alert-text').text(message);
  }

  function request(event, data, timeout = 10000) {
    if (!socket.connected) return Promise.reject(new Error('The connection was lost. Try again when connected.'));
    return new Promise((resolve, reject) => {
      socket.timeout(timeout).emit(event, data, (timeoutError, error, result) => {
        if (timeoutError) reject(new Error('The request timed out. Check the conversation before retrying.'));
        else if (error) reject(new Error(error));
        else resolve(result);
      });
    });
  }

  function send(event, data) {
    return request(event, data).catch((error) => showError(error.message));
  }

  const sfu = new SfuClient(socket, request);

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
    return 'background: linear-gradient(135deg, hsl(' + h1 + ', 70%, 26%), hsl(' + h2 + ', 75%, 22%));';
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

  let directCall = null;
  let activeMediaStream = null;
  let personalCallTimerTimeout = null;
  let activeChatMode = 'group';
  let activePrivateUserId = '';
  let activePrivateUserName = '';
  let currentRoomName = params.room;
  let currentUserName = params.name;
  let currentUserStatus = 'online';
  let knownRoomsList = [];
  let groupUnreadCounts = Object.create(null);
  let roomCall = null;
  let roomLocalStream = null;
  let roomScreenStream = null;
  let roomCallTimerTimeout = null;
  let roomTrackOwners = Object.create(null);

  // Message Tracking, Deduplication & Typing
  var rendered_message_ids = new Set();
  var room_typing_users = Object.create(null);
  var roomTypingStopTimeout = null;
  var privateTypingStopTimeout = null;
  var QUICK_REACTIONS = ['👍', '❤️', '🎉', '🚀', '👀'];

  // Personal message history & unread counters
  var user_message_dictionary = Object.create(null);
  var unread_counts = Object.create(null);
  var room_users_map = Object.create(null);

  const calling_audio = document.getElementById('audioCalling');
  const soundSettingsKey = 'nexus_sound_preferences';
  const soundSettings = document.querySelector('.sound-settings');
  const messageSounds = document.getElementById('message-sounds');
  const callSounds = document.getElementById('call-sounds');
  const messageVolume = document.getElementById('message-volume');
  const callVolume = document.getElementById('call-volume');
  const previewStatus = document.getElementById('sound-preview-status');
  const tonePickers = [
    { kind: 'message', preference: 'messageTone', field: document.getElementById('message-tones'), label: 'message tone' },
    { kind: 'incoming', preference: 'ringtone', field: document.getElementById('incoming-ringtones'), label: 'ringtone' },
    { kind: 'outgoing', preference: 'ringback', field: document.getElementById('outgoing-ringbacks'), label: 'ringback' },
  ];

  function readSoundPreferences() {
    try {
      return JSON.parse(localStorage.getItem(soundSettingsKey));
    } catch {
      return null;
    }
  }

  const sounds = new ChatSounds(readSoundPreferences());
  const toneOption = document.getElementById('sound-tone-option');
  for (const { kind, preference, field, label } of tonePickers) {
    for (const [tone, pattern] of Object.entries(CHAT_SOUND_PATTERNS[kind])) {
      const option = toneOption.content.cloneNode(true);
      const input = option.querySelector('input');
      input.name = preference;
      input.value = tone;
      option.querySelector('span').textContent = pattern.label;
      const preview = option.querySelector('button');
      preview.dataset.previewSound = kind;
      preview.dataset.tone = tone;
      preview.title = 'Preview ' + pattern.label + ' ' + label;
      preview.setAttribute('aria-label', preview.title);
      field.append(option);
    }
  }

  function showSoundPreferences() {
    const preferences = sounds.preferences;
    messageSounds.checked = preferences.messages;
    callSounds.checked = preferences.calls;
    for (const [input, value] of [[messageVolume, preferences.messageVolume], [callVolume, preferences.callVolume]]) {
      input.value = value;
      input.setAttribute('aria-valuetext', value + '%');
      document.getElementById(input.id + '-value').value = value + '%';
    }
    for (const { preference, field } of tonePickers) {
      for (const option of field.querySelectorAll('input')) option.checked = option.value === preferences[preference];
    }
  }

  function applySoundPreferences() {
    const preferences = {
      messages: messageSounds.checked,
      calls: callSounds.checked,
      messageVolume: messageVolume.valueAsNumber,
      callVolume: callVolume.valueAsNumber,
    };
    for (const { preference, field } of tonePickers) {
      preferences[preference] = field.querySelector('input:checked').value;
    }
    sounds.setPreferences(preferences);
    showSoundPreferences();
    previewStatus.textContent = '';
  }

  function saveSoundPreferences() {
    applySoundPreferences();
    try {
      localStorage.setItem(soundSettingsKey, JSON.stringify(sounds.preferences));
    } catch {
      // The preference still applies to this tab when storage is unavailable.
    }
  }

  showSoundPreferences();
  soundSettings.addEventListener('change', saveSoundPreferences);
  for (const slider of [messageVolume, callVolume]) slider.addEventListener('input', applySoundPreferences);
  for (const button of soundSettings.querySelectorAll('[data-preview-sound]')) {
    button.addEventListener('click', async () => {
      const kind = button.dataset.previewSound;
      previewStatus.textContent = '';
      if (roomCall || directCall) {
        previewStatus.textContent = 'Sound previews are available after the call.';
      } else if (sounds.volumeFor(kind) === 0) {
        sounds.stopPreview();
        previewStatus.textContent = kind === 'message' ? 'Raise the message volume to preview.' : 'Raise the call volume to preview.';
      } else if (await sounds.preview(kind, button.dataset.tone) === false) {
        previewStatus.textContent = 'Sound playback is unavailable in this tab.';
      }
    });
  }
  soundSettings.addEventListener('toggle', () => {
    if (!soundSettings.open) {
      sounds.stopPreview();
      previewStatus.textContent = '';
    }
  });
  window.addEventListener('storage', ({ key }) => {
    if (key !== soundSettingsKey && key !== null) return;
    sounds.setPreferences(readSoundPreferences());
    showSoundPreferences();
  });
  for (const eventName of ['click', 'keydown']) {
    document.addEventListener(eventName, (event) => {
      if (event.isTrusted && (messageSounds.checked || callSounds.checked)) sounds.enable();
    }, { capture: true });
  }
  window.addEventListener('pagehide', () => {
    sounds.setRinging(null);
    sounds.stopMessage();
    sounds.stopPreview();
  });

  function notifyMessage() {
    if (!directCall && !roomCall) sounds.notifyMessage();
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
      $('#group-empty-desc').text('Send the first message to start the conversation.');
      $('#group-empty-state').removeClass('hide-element');
    } else {
      $('#group-empty-state').addClass('hide-element');
    }

    if (activeChatMode === 'personal' && activePrivateUserId) {
      var personalMsgs = user_message_dictionary[activePrivateUserId] || [];
      if (personalMsgs.length === 0) {
        $('#personal-empty-title').text('Direct Message with ' + activePrivateUserName);
        $('#personal-empty-desc').text('Send a message to start the conversation.');
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

  function setSidebar(open) {
    $('#chat__sidebar').toggleClass('hide-show-people', open);
    $('#show-people').attr('aria-expanded', String(open)).toggleClass('change-button-position', open);
    $('#change-arrow').toggleClass('fa-xmark', open).toggleClass('fa-bars', !open);
  }

  async function selectGroupFromSidebar(targetRoom) {
    if (!ready || switching || !targetRoom) return;
    if (targetRoom.toLowerCase() === currentRoomName.toLowerCase()) {
      switchToGroupChatCanvas();
      setSidebar(false);
      return;
    }
    switching = true;
    try {
      await request('room:switch', { room: targetRoom });
      $('#quick-group-input').val('');
      renderGroupsSidebar();
      setSidebar(false);
    } catch (error) {
      showError(error.message);
    } finally {
      switching = false;
    }
  }

  $('#quick-group-form').on('submit', (event) => {
    event.preventDefault();
    selectGroupFromSidebar($('#quick-group-input').val().trim());
  });

  $('#quick-group-input').on('input', function () {
    renderGroupsSidebar();
  });

  /* ==========================================================================
     Canvas Switching (Group Chat vs Personal Chat)
     ========================================================================== */

  const directDrafts = new Map();
  function saveDirectDraft() {
    const peer = room_users_map[activePrivateUserId];
    if (peer) directDrafts.set(peer.guestId, $('#private-message-input').val());
  }

  function switchToGroupChatCanvas() {
    saveDirectDraft();
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
    $('#header-chat-subtitle').text('Group chat');
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

    saveDirectDraft();
    $('#private-message-input').val(directDrafts.get(peerUser?.guestId) || '');
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

    setSidebar(false);
  }

  $('#back-to-group-btn').on('click', function (e) {
    e.preventDefault();
    switchToGroupChatCanvas();
  });

  function formatCallDuration(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    var hrs = Math.floor(s / 3600);
    var mins = Math.floor((s % 3600) / 60);
    var remSecs = s % 60;
    if (hrs > 0) {
      return hrs + 'h ' + mins + 'm ' + (remSecs < 10 ? '0' : '') + remSecs + 's';
    }
    if (mins === 0) {
      return s + 's';
    }
    return mins + 'm ' + (remSecs < 10 ? '0' : '') + remSecs + 's';
  }

  function showTimer(selector, startedAt) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $(selector).text([Math.floor(seconds / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':'));
  }

  function playRemoteMedia(element, stream, button) {
    if (element.srcObject === stream) return;
    element.srcObject = stream;
    button.hidden = true;
    const play = async () => {
      try {
        await element.play();
        if (element.srcObject === stream) button.hidden = true;
      } catch (error) {
        if (element.srcObject !== stream) return;
        if (error.name === 'NotAllowedError') button.hidden = false;
        else if (error.name !== 'AbortError') showError('The call media could not be played.');
      }
    };
    button.onclick = play;
    play();
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
      if (!isSelf) {
        const playButton = document.createElement('button');
        playButton.type = 'button';
        playButton.className = 'sfu-video-tile__play';
        playButton.textContent = 'Play media';
        playButton.setAttribute('aria-label', 'Play media for ' + labelText);
        playButton.hidden = true;
        existingTile.appendChild(playButton);
      }
      existingTile.appendChild(badge);
      grid.appendChild(existingTile);
    } else {
      videoEl = existingTile.querySelector('video');
      var nameSpan = existingTile.querySelector('.sfu-video-tile__label span');
      if (nameSpan && labelText) {
        nameSpan.textContent = labelText;
      }
    }

    if (isSelf) {
      if (videoEl.srcObject !== stream) videoEl.srcObject = stream;
    } else {
      playRemoteMedia(videoEl, stream, existingTile.querySelector('.sfu-video-tile__play'));
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

  function updateRoomCallStatus(participants) {
    $('#room-call-count').text(String(participants.length));
    $('#room-call-active-badge').toggleClass('hide-element', participants.length === 0);
  }

  function updateRoomOwners(owners) {
    Object.assign(roomTrackOwners, owners);
    for (const [id, owner] of Object.entries(owners)) {
      const tile = document.getElementById('sfu-tile-' + id);
      if (tile) {
        tile.querySelector('.sfu-video-tile__label span').textContent =
          owner.name + (owner.screenSharing ? ' (Screen)' : '') + (owner.audioEnabled === false ? ' (Muted)' : '');
      }
    }
  }

  const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());
  const roomSessionId = () => 'room:chat:' + currentRoomName.toLowerCase();

  async function joinRoomSfuCall(mode) {
    if (!ready || switching || roomCall) return;
    if (directCall) return showError('End your direct call before joining a group call.');
    const call = { sessionId: roomSessionId(), media: null };
    roomCall = call;
    sounds.stopMessage();
    sounds.stopPreview();
    $('#join-room-audio-btn, #join-room-video-btn').prop('disabled', true);
    $('#room-call-mode-label').text(currentRoomName + ' · ' + (mode === 'video' ? 'Video call' : 'Audio call'));
    $('#room-call-timer').text('Connecting…');
    $('#room-call-stage').removeClass('hide-element');
    $('#room-toggle-cam').toggleClass('hide-element', mode === 'audio');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
      if (roomCall !== call) return stopTracks(stream);
      roomLocalStream = stream;
      renderRoomVideoTile('local-self', currentUserName + ' (You)', stream, true);
      call.media = await sfu.start(call.sessionId, mode, stream, {
        reserveVideo: true,
        onOwners: updateRoomOwners,
        onTrack: (event) => {
          const remote = event.streams[0];
          if (remote) renderRoomVideoTile(remote.id, roomTrackOwners[remote.id]?.name || 'Guest', remote, false);
        },
        onConnected: () => {
          if (roomCallTimerTimeout) return;
          const startedAt = Date.now();
          showTimer('#room-call-timer', startedAt);
          roomCallTimerTimeout = setInterval(() => showTimer('#room-call-timer', startedAt), 1000);
        },
        onError: (message) => {
          if (roomCall !== call) return;
          showError(message);
          leaveRoomSfuCall();
        },
      });
    } catch (error) {
      if (roomCall !== call) return;
      showError(error.message);
      leaveRoomSfuCall();
    }
  }

  async function toggleRoomScreenShare() {
    const call = roomCall;
    const sender = call?.media?.videoSender;
    if (!sender) return showError('Wait for the call to connect before sharing your screen.');
    const button = $('#room-toggle-screen').prop('disabled', true);
    try {
      if (roomScreenStream) {
        await sender.replaceTrack(roomLocalStream.getVideoTracks()[0] || null);
        if (roomCall !== call) return;
        stopTracks(roomScreenStream);
        roomScreenStream = null;
        renderRoomVideoTile('local-self', currentUserName + ' (You)', roomLocalStream, true);
      } else {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        if (roomCall !== call) return stopTracks(stream);
        try {
          await sender.replaceTrack(stream.getVideoTracks()[0]);
          if (roomCall !== call) return stopTracks(stream);
        } catch (error) {
          stopTracks(stream);
          throw error;
        }
        roomScreenStream = stream;
        stream.getVideoTracks()[0].addEventListener('ended', toggleRoomScreenShare, { once: true });
        renderRoomVideoTile('local-self', currentUserName + ' (Screen)', stream, true);
      }
      button.toggleClass('muted-state', Boolean(roomScreenStream)).attr('aria-pressed', String(Boolean(roomScreenStream)));
      send('sfu:media-state', { sessionId: call.sessionId, screenSharing: Boolean(roomScreenStream) });
    } catch (error) {
      if (roomCall === call && error.name !== 'NotAllowedError') showError(error.message);
    } finally {
      button.prop('disabled', false);
    }
  }

  function leaveRoomSfuCall(notify = true) {
    if (!roomCall) return;
    if (notify && socket.connected) send('sfu:leave', { sessionId: roomCall.sessionId });
    roomCall = null;
    sfu.close();
    stopTracks(roomLocalStream);
    stopTracks(roomScreenStream);
    roomLocalStream = null;
    roomScreenStream = null;
    roomTrackOwners = Object.create(null);
    clearInterval(roomCallTimerTimeout);
    roomCallTimerTimeout = null;
    $('#room-video-grid').empty();
    $('#room-call-stage').addClass('hide-element');
    $('#join-room-audio-btn, #join-room-video-btn').prop('disabled', false);
    resetMediaButtons('room');
  }

  socket.on('sfu:participant-left', ({ sessionId, streamId }) => {
    if (roomCall?.sessionId === sessionId) removeRoomVideoTile(streamId);
  });

  socket.on('sfu:media-state', (state) => {
    if (roomCall?.sessionId === state.sessionId) updateRoomOwners({ [state.streamId]: state });
  });

  socket.on('sfu:room-call-status', ({ sessionId, participants }) => {
    if (sessionId === roomSessionId()) updateRoomCallStatus(participants);
  });

  $('#join-room-audio-btn').on('click', () => joinRoomSfuCall('audio'));
  $('#join-room-video-btn').on('click', () => joinRoomSfuCall('video'));
  $('#room-leave-call').on('click', () => leaveRoomSfuCall());
  $('#room-toggle-screen').on('click', toggleRoomScreenShare);

  function resetMediaButtons(scope) {
    $('#' + scope + '-toggle-mic').removeClass('muted-state').attr('aria-pressed', 'false').find('i').attr('class', 'fa-solid fa-microphone');
    $('#' + scope + '-toggle-cam').removeClass('muted-state').attr('aria-pressed', 'false').find('i').attr('class', 'fa-solid fa-video');
    $('#' + scope + '-toggle-screen').removeClass('muted-state').attr('aria-pressed', 'false');
  }

  function toggleTrack(button, stream, sessionId, kind) {
    const tracks = kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks();
    if (!tracks?.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach((track) => { track.enabled = enabled; });
    const icon = kind === 'audio' ? 'microphone' : 'video';
    button.toggleClass('muted-state', !enabled).attr('aria-pressed', String(!enabled));
    button.find('i').attr('class', 'fa-solid fa-' + icon + (enabled ? '' : '-slash'));
    send('sfu:media-state', { sessionId, [kind + 'Enabled']: enabled });
  }

  $('#room-toggle-mic').on('click', function () {
    toggleTrack($(this), roomLocalStream, roomCall?.sessionId, 'audio');
  });
  $('#room-toggle-cam').on('click', function () {
    toggleTrack($(this), roomLocalStream, roomCall?.sessionId, 'video');
  });

  $('#presence-status-select').on('change', async function () {
    const status = this.value;
    try {
      await request('presence:update', { status });
      currentUserStatus = status;
      sounds.setQuiet(status === 'dnd');
      $('#current-user-status-dot').attr('class', 'user-avatar-status-dot status-' + status);
    } catch (error) {
      this.value = currentUserStatus;
      showError(error.message);
    }
  });

  function applySearchFilter() {
    const query = $('#room-message-search').val().trim().toLowerCase();
    $('#clear-search-btn').toggleClass('hide-element', !query);
    const list = activeChatMode === 'group' ? '#messages' : '#private_messages_list';
    $(list + ' > li').each(function () {
      $(this).toggleClass('hide-element', !$(this).find('.message__title, .message__body').text().toLowerCase().includes(query));
    });
  }

  function setMobileSearch(open) {
    $('.chat__header').toggleClass('chat__header--search-open', open);
    $('#toggle-search-btn').attr('aria-expanded', String(open));
    if (open) $('#room-message-search').trigger('focus');
    else $('#room-message-search').val('').trigger('input');
  }

  $('#toggle-search-btn').on('click', () => setMobileSearch($('#toggle-search-btn').attr('aria-expanded') !== 'true'));
  $('#room-message-search').on('input', applySearchFilter);
  $('#clear-search-btn').on('click', () => $('#room-message-search').val('').trigger('input').trigger('focus'));

  function renderPrivateMessages(userId) {
    var $list = $('#private_messages_list');
    $list.empty();

    var messages = user_message_dictionary[userId] || [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var isMine = msg.authorId === guestId;
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
          createdAt: time.format(msg.createdAt),
          initials: initials,
          extraClass: extraClass,
        });
      } else if (msg.type === 'file') {
        template = $('#file-message-template').html();
        html = Mustache.render(template, {
          from: msg.from,
          url: msg.url,
          filename: msg.filename,
          createdAt: time.format(msg.createdAt),
          initials: initials,
          extraClass: extraClass,
        });
      } else if (msg.type === 'call') {
        const video = msg.mode === 'video';
        const duration = msg.wasConnected ? formatCallDuration(msg.durationSec) :
          ({ declined: 'Declined', no_answer: 'No answer', left: 'Participant left', failed: 'Connection failed' })[msg.reason] || 'Cancelled';
        template = $('#call-message-template').html();
        html = Mustache.render(template, {
          from: msg.from,
          callTitle: video ? 'Video call' : 'Audio call',
          callDuration: duration,
          callIcon: video ? 'fa-solid fa-video' : 'fa-solid fa-phone',
          callStatusClass: msg.wasConnected ? 'call-status--completed' : 'call-status--missed',
          createdAt: time.format(msg.createdAt),
          initials: initials,
          extraClass: extraClass,
        });
      } else {
        template = $('#private-message-template').html();
        html = Mustache.render(template, {
          text: msg.text,
          from: msg.from,
          createdAt: time.format(msg.createdAt),
          initials: initials,
          extraClass: extraClass,
        });
      }
      var $item = $(html);
      $item.find('.message__avatar').attr('style', avatarStyle);
      $list.append($item);
    }
    if (!directCall) {
      $list.scrollTop($list.prop('scrollHeight') || 0);
    }
    updateEmptyStates();
    applySearchFilter();
  }

  $('#dismiss-alert').on('click', function (e) {
    e.preventDefault();
    $('#alert-box').addClass('alert-hide');
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
      var isMine = usersList.some((reaction) => reaction.authorId === guestId);

      var $btn = $('<button type="button" class="reaction-btn"></button>');
      if (isMine) $btn.addClass('active-reaction');
      $btn.attr('aria-pressed', String(isMine));
      $btn.text(count > 0 ? emoji + ' ' + count : emoji);
      if (count > 0) {
        $btn.attr('title', usersList.map((reaction) => reaction.name).join(', '));
      }
      $btn.on('click', function (e) {
        e.preventDefault();
        send('message:reaction', {
          messageId: messageId,
          emoji: emoji,
        });
      });
      $bar.append($btn);
    });
  }

  function appendRoomMessageItem(message, isHistoryReplay) {
    if (!message) return;
    if (message.id && rendered_message_ids.has(message.id)) return;
    if (message.id) {
      rendered_message_ids.add(message.id);
    }

    var formattedTime = time.format(message.createdAt);
    var isMine = message.authorId === guestId;
    var initials = getInitials(message.from);
    var avatarStyle = getAvatarStyle(message.from);
    var extraClass = isMine ? 'message--outgoing' : '';
    var template;
    var html;
    var isTextMessage = false;

    if (message.type === 'location') {
      template = $('#location-message-template').html();
      html = Mustache.render(template, {
        from: message.from,
        url: message.url,
        createdAt: formattedTime,
        initials: initials,
        extraClass: extraClass,
      });
    } else if (message.type === 'file') {
      template = $('#file-message-template').html();
      html = Mustache.render(template, {
        from: message.from,
        url: message.url,
        filename: message.filename,
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

    if (message.id) {
      var $toolbar = $('<div class="message-toolbar"></div>');
      var $reactionBar = $('<div class="reaction-bar"></div>');
      $toolbar.append($reactionBar);

      if (isMine) {
        var $ownerActions = $('<div class="msg-owner-actions"></div>');
        if (isTextMessage) {
          var $editBtn = $(
            '<button type="button" class="msg-action-btn" title="Edit message"><i class="fa-solid fa-pen"></i></button>'
          );
          $editBtn.on('click', function (e) {
            e.preventDefault();
            openMessageDialog(message.id, $li.find('.message__body p').text());
          });
          $ownerActions.append($editBtn);
        }

        var $delBtn = $(
          '<button type="button" class="msg-action-btn msg-action-delete" title="Delete message"><i class="fa-solid fa-trash-can"></i></button>'
        );
        $delBtn.on('click', function (e) {
          e.preventDefault();
          openMessageDialog(message.id);
        });
        $ownerActions.append($delBtn);
        $toolbar.append($ownerActions);
      }

      $li.find('.message__content').append($toolbar);
      renderMessageReactions($li, message.id, message.reactions);
    }

    $('#messages').append($li);
    const items = $('#messages > li');
    if (items.length > historyLimit) {
      rendered_message_ids.delete(items.first().attr('data-message-id'));
      items.first().remove();
    }
    updateEmptyStates();
    if (activeChatMode === 'group') applySearchFilter();

    if (activeChatMode === 'group') {
      scrollToBottom('#messages');
    } else if (!isHistoryReplay && !isMine) {
      incrementGroupUnreadBadge(currentRoomName);
    }
    if (!isHistoryReplay && !isMine && (activeChatMode !== 'group' || document.hidden)) {
      notifyMessage();
    }
  }

  let dialogMessage = null;
  const dialog = document.getElementById('message-dialog');

  function openMessageDialog(id, text) {
    const editing = text !== undefined;
    dialogMessage = { id, editing, room: currentRoomName };
    $('#message-dialog-status').text('');
    $('#message-dialog-title').text(editing ? 'Edit message' : 'Delete message?');
    $('#message-edit-label, #message-edit-input').toggleClass('hide-element', !editing);
    $('#message-edit-input').val(text || '').prop('required', editing);
    $('#message-dialog-submit').text(editing ? 'Save changes' : 'Delete message').prop('disabled', false);
    dialog.showModal();
    $(editing ? '#message-edit-input' : '#message-dialog-cancel').trigger('focus');
  }

  $('#message-dialog-cancel').on('click', () => dialog.close());
  $('#message-dialog-form').on('submit', async (event) => {
    event.preventDefault();
    const { id, editing, room } = dialogMessage;
    const text = $('#message-edit-input').val().trim();
    if (!ready || switching || room !== currentRoomName || (editing && !text)) return;
    $('#message-dialog-submit').prop('disabled', true);
    try {
      await request(editing ? 'message:edit' : 'message:delete', { messageId: id, text });
      dialog.close();
    } catch (error) {
      $('#message-dialog-status').text(error.message);
      $('#message-dialog-submit').prop('disabled', false);
    }
  });

  socket.on('updateRoomList', function (rooms) {
    knownRoomsList = rooms.slice();
    ensureRoomInKnownList(currentRoomName);
    renderGroupsSidebar();
  });

  socket.on('message:edited', function (data) {
    if (!data || !data.messageId) return;
    var $li = $('#messages li.message[data-message-id="' + data.messageId + '"]');
    if (!$li.length) return;
    $li.find('.message__body p').text(data.text);
    applySearchFilter();
    if (!$li.find('.edited-tag').length) {
      $li.find('.user-time').after('<span class="edited-tag">(edited)</span>');
    }
  });

  socket.on('message:deleted', function (data) {
    if (!data || !data.messageId) return;
    rendered_message_ids.delete(data.messageId);
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
      return room_typing_users[uid].name;
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
      const typing = { name: data.name };
      room_typing_users[data.userId] = typing;
      setTimeout(() => {
        if (room_typing_users[data.userId] !== typing) return;
        delete room_typing_users[data.userId];
        updateRoomTypingBanner();
      }, 2500);
    } else {
      delete room_typing_users[data.userId];
    }
    updateRoomTypingBanner();
  });

  let directTypingTimer;
  socket.on('dm:typing', function (data) {
    if (!data || !data.userId) return;
    if (getActivePrivateUserId() !== data.userId) return;
    var $indicator = $('#private-typing-indicator');
    clearTimeout(directTypingTimer);
    if (data.isTyping && data.name) {
      $indicator
        .removeClass('hide-element')
        .html('<span class="typing-dots"><span></span><span></span><span></span></span> ' + $('<div>').text(data.name + ' is typing...').html());
      directTypingTimer = setTimeout(() => $indicator.addClass('hide-element').empty(), 2500);
    } else {
      $indicator.addClass('hide-element').empty();
    }
  });

  async function uploadFile(input, privateUpload) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    const peer = privateUpload ? getActivePrivateUserId() : '';
    if (!ready || switching || (privateUpload && !peer)) return showError('Open a conversation before sharing files.');
    if (file.size > 50 * 1024 * 1024) return showError('Files must be 50 MB or smaller.');

    const data = new FormData();
    data.append('file', file);
    const progress = document.getElementById(privateUpload ? 'private-upload-progress-bar' : 'upload-progress-bar');
    const bar = progress.firstElementChild;
    const button = $(privateUpload ? '#private-send-file-click' : '#send-file').prop('disabled', true);
    function setProgress(percent) {
      bar.style.width = percent + '%';
      bar.textContent = percent + '%';
      bar.setAttribute('aria-valuenow', String(percent));
    }
    setProgress(0);
    progress.classList.remove('hide-element');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.responseType = 'json';
    xhr.timeout = 120000;
    xhr.setRequestHeader('X-Chat-Connection', socket.id);
    xhr.setRequestHeader('X-Chat-Channel', encodeURIComponent('chat:' + currentRoomName.toLowerCase()));
    if (peer) xhr.setRequestHeader('X-Chat-Peer', peer);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) setProgress(Math.round(100 * event.loaded / event.total));
    });
    xhr.addEventListener('loadend', () => {
      button.prop('disabled', false);
      progress.classList.add('hide-element');
      if (xhr.status !== 201) showError(xhr.response?.error || 'The upload could not be confirmed. Check the conversation before retrying.');
    });
    xhr.send(data);
  }

  $('#input-file').on('change', function () { uploadFile(this, false); });
  $('#private-send-file').on('change', function () { uploadFile(this, true); });
  $('#send-file').on('click', () => document.getElementById('input-file').click());
  $('#private-send-file-click').on('click', () => document.getElementById('private-send-file').click());

  function setConnection(label, connected) {
    ready = connected;
    $('#connection-status-text').text(label);
    $('.status-pulse-dot').toggleClass('status-pulse-dot--disconnected', !connected);
    $('#message-input, #private-message-input, #group-send-btn, #private-send-btn, #quick-group-btn, #presence-status-select')
      .prop('disabled', !connected);
  }

  socket.on('room:state', ({ user, users, messages, participants, historyLimit: limit }) => {
    historyLimit = limit;
    if (roomCall && roomCall.sessionId !== 'room:chat:' + user.room.toLowerCase()) leaveRoomSfuCall(false);
    if (dialog.open) dialog.close();
    const sameRoom = currentRoomName.toLowerCase() === user.room.toLowerCase();
    const previousPeer = sameRoom ? room_users_map[activePrivateUserId]?.guestId : null;
    if (!sameRoom) $('#message-input, #private-message-input').val('');
    currentRoomName = user.room;
    currentUserName = user.name;
    currentUserStatus = user.status;
    sounds.setQuiet(user.status === 'dnd');
    sessionStorage.setItem('nexus_join', JSON.stringify({ name: user.name, room: user.room }));
    $('#current-user-name').text(user.name);
    $('#current-user-avatar').text(getInitials(user.name)).attr('style', getAvatarStyle(user.name));
    $('#presence-status-select').val(user.status);
    $('#current-user-status-dot').attr('class', 'user-avatar-status-dot status-' + user.status);
    rendered_message_ids.clear();
    room_typing_users = Object.create(null);
    user_message_dictionary = Object.create(null);
    unread_counts = Object.create(null);
    clearTimeout(roomTypingStopTimeout);
    clearTimeout(privateTypingStopTimeout);
    roomTypingStopTimeout = null;
    privateTypingStopTimeout = null;
    updateRoomTypingBanner();
    $('#messages').empty();
    switchToGroupChatCanvas();
    if (!sameRoom) directDrafts.clear();
    $('#private-message-input').val('');
    for (const message of messages) appendRoomMessageItem(message, true);
    $('#messages').scrollTop($('#messages').prop('scrollHeight'));
    updateRoomCallStatus(participants);
    updateUsers(users);
    setConnection('Connected', true);
    $('#alert-box').addClass('alert-hide');
    const returningPeer = previousPeer && users.find((person) => person.guestId === previousPeer);
    if (returningPeer) openPersonalChatForPeer(returningPeer.id);
  });

  socket.on('connect', async () => {
    setConnection('Joining…', false);
    try {
      await request('join', { name: currentUserName, room: currentRoomName });
    } catch (error) {
      if (!socket.connected) return;
      socket.disconnect();
      setConnection('Join failed', false);
      showError(error.message + ' Use Leave group to change your details.');
    }
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') {
      setConnection('Disconnected', false);
      showError('This session was closed. Reload the page to rejoin.');
    } else {
      setConnection('Reconnecting…', false);
    }
    closeDirectCall();
    leaveRoomSfuCall(false);
    sounds.stopMessage();
  });

  socket.on('connect_error', () => {
    setConnection('Connecting…', false);
    showError('The chat server is unavailable. Use Leave group to try a new session.');
  });

  async function openPersonalChatForPeer(id) {
    const peer = room_users_map[id];
    if (!ready || switching || !peer || peer.guestId === guestId) return;
    switchToPersonalChatCanvas(id, peer.name);
    $('#private-message-input').trigger('focus');
    const room = currentRoomName;
    try {
      const history = await request('dm:history', { peerId: id });
      if (currentRoomName !== room || !room_users_map[id]) return;
      const combined = new Map(history.map((message) => [message.id, message]));
      for (const message of user_message_dictionary[id] || []) combined.set(message.id, message);
      user_message_dictionary[id] = Array.from(combined.values()).slice(-historyLimit);
      if (getActivePrivateUserId() === id) renderPrivateMessages(id);
    } catch (error) {
      if (getActivePrivateUserId() === id) showError(error.message);
    }
  }

  function updateUsers(users) {
    if (!Array.isArray(users)) return;
    var userfound = false;
    var activePrivateId = getActivePrivateUserId();
    var $ol = $('<ol></ol>');
    room_users_map = Object.create(null);

    $('#online-count').text(String(new Set(users.map((user) => user.guestId)).size - 1));

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

      if (user.guestId === guestId && user.id !== socket.id) return;
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

        var $chatBtn = $('<button type="button" class="btn-chat-trigger"><i class="fa-regular fa-comment-dots" aria-hidden="true"></i></button>').attr('aria-label', 'Message ' + user.name);
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

    if (activePrivateId && !userfound) {
      switchToGroupChatCanvas();
    }

    for (const id of Object.keys(user_message_dictionary)) {
      if (!room_users_map[id]) {
        delete user_message_dictionary[id];
      }
    }
    for (const id of Object.keys(unread_counts)) {
      if (!room_users_map[id]) delete unread_counts[id];
    }
    $('#users').empty().append($ol);
    renderGroupsSidebar();
  }
  socket.on('updateUserList', updateUsers);

  socket.on('newMessage', (message) => appendRoomMessageItem(message, false));
  socket.on('dm:message', ({ peer, message }) => {
    const id = peer.id;
    const messages = user_message_dictionary[id] || [];
    if (messages.some((item) => item.id === message.id)) return;
    user_message_dictionary[id] = [...messages, message].slice(-historyLimit);
    if (getActivePrivateUserId() === id) {
      $('#private-typing-indicator').addClass('hide-element').empty();
      renderPrivateMessages(id);
    } else if (message.authorId !== guestId) {
      incrementUnreadBadge(id);
    }
    if (message.authorId !== guestId && message.type !== 'call') notifyMessage();
  });

  $('#message-input').on('input', function () {
    if (!ready || switching) return;
    if (!roomTypingStopTimeout) socket.volatile.emit('typing:update', { isTyping: true });
    clearTimeout(roomTypingStopTimeout);
    roomTypingStopTimeout = setTimeout(() => {
      roomTypingStopTimeout = null;
      socket.volatile.emit('typing:update', { isTyping: false });
    }, 1500);
  });

  $('#private-message-input').on('input', function () {
    const peerId = getActivePrivateUserId();
    if (!peerId || !ready || switching) return;
    if (!privateTypingStopTimeout) socket.volatile.emit('dm:typing', { peerId, isTyping: true });
    clearTimeout(privateTypingStopTimeout);
    privateTypingStopTimeout = setTimeout(() => {
      privateTypingStopTimeout = null;
      socket.volatile.emit('dm:typing', { peerId, isTyping: false });
    }, 1500);
  });

  function bindComposer(formId, inputId, buttonId, direct) {
    let sending = false;
    $(formId).on('submit', async (event) => {
      event.preventDefault();
      const input = $(inputId);
      const text = input.val().trim();
      const peerId = getActivePrivateUserId();
      const peerGuestId = room_users_map[peerId]?.guestId;
      if (!ready || switching || sending || !text || (direct && !peerId)) return;
      sending = true;
      $(buttonId).prop('disabled', true);
      try {
        await request(direct ? 'dm:send' : 'createMessage', direct ? { peerId, text } : { text });
        if (direct && getActivePrivateUserId() !== peerId) {
          if (directDrafts.get(peerGuestId)?.trim() === text) directDrafts.delete(peerGuestId);
        } else if (input.val().trim() === text) {
          input.val('');
        }
      } catch (error) {
        showError(error.message);
      } finally {
        sending = false;
        $(buttonId).prop('disabled', !ready);
      }
    });
  }

  bindComposer('#message-form', '#message-input', '#group-send-btn', false);
  bindComposer('#private-message-form', '#private-message-input', '#private-send-btn', true);

  function bindLocation(selector, direct) {
    $(selector).on('click', function () {
      const peerId = getActivePrivateUserId();
      if (!ready || switching || (direct && !peerId)) return;
      if (!navigator.geolocation) return showError('Location sharing is unavailable in this browser.');
      const room = currentRoomName;
      const connection = socket.id;
      const button = $(this).prop('disabled', true);
      navigator.geolocation.getCurrentPosition(async ({ coords }) => {
        button.prop('disabled', false);
        if (room !== currentRoomName || connection !== socket.id || switching || (direct && peerId !== getActivePrivateUserId())) {
          showError('The conversation changed before your location could be shared.');
          return;
        }
        const { latitude, longitude } = coords;
        await send(direct ? 'dm:location' : 'createLocationMessage', { peerId, latitude, longitude });
      }, (error) => {
        button.prop('disabled', false);
        showError('Unable to share your location. ' + error.message);
      }, { timeout: 10000, maximumAge: 0 });
    });
  }

  bindLocation('#send-location', false);
  bindLocation('#private-send-location', true);

  function showDirectStage(call, label, status) {
    $('#personal-call-title').text(label);
    $('#personal-call-timer').text(status);
    $('#personal-call-stage').removeClass('hide-element');
    $('#personal-toggle-cam').toggleClass('hide-element', call.mode === 'audio');
    $('#audio-call, #video-call').prop('disabled', true);
    resetMediaButtons('personal');
  }

  async function startDirectCall(mode) {
    const peer = room_users_map[getActivePrivateUserId()];
    if (!ready || switching || !peer || directCall) return;
    if (roomCall) return showError('Leave the group call before starting a direct call.');
    const call = { mode, peer, id: null };
    directCall = call;
    sounds.stopMessage();
    sounds.stopPreview();
    showDirectStage(call, 'Calling ' + peer.name, 'Ringing…');
    try {
      const { id } = await request('call:start', { peerId: peer.id, mode });
      call.id = id;
      if (directCall !== call) return send('call:end', { id });
      if (!call.accepted) sounds.setRinging('outgoing');
    } catch (error) {
      if (directCall === call) {
        showError(error.message);
        closeDirectCall();
      }
    }
  }

  socket.on('call:incoming', ({ id, caller, mode }) => {
    if (directCall || roomCall) return send('call:end', { id, reason: 'declined' });
    directCall = { id, peer: caller, mode, incoming: true };
    $('#incoming-caller-avatar').text(getInitials(caller.name)).attr('style', getAvatarStyle(caller.name));
    $('#incoming-caller-name').text(caller.name);
    $('#incoming-call-label').text(mode === 'video' ? 'Incoming video call' : 'Incoming audio call');
    $('#incoming-call-card').removeClass('hide-element');
    sounds.setRinging('incoming');
  });

  async function connectDirectMedia(call) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.mode === 'video' });
      if (directCall !== call) return stopTracks(stream);
      activeMediaStream = stream;
      if (call.mode === 'video') {
        document.getElementById('self-video').srcObject = stream;
        $('#private-video-stage').removeClass('hide-element');
      }
      await sfu.start('private:' + call.id, call.mode, stream, {
        onOwners: () => {},
        onTrack: (event) => {
          const remote = event.streams[0];
          if (!remote) return;
          const isVideo = call.mode === 'video';
          const element = isVideo ? document.getElementById('other-video') : calling_audio;
          if (isVideo) $('#other-video-name').text(call.peer.name);
          playRemoteMedia(element, remote, document.getElementById('personal-play-media'));
        },
        onError: (message) => {
          if (directCall !== call) return;
          showError(message);
          endDirectCall('failed');
        },
      });
    } catch (error) {
      if (directCall !== call) return;
      showError(error.message);
      endDirectCall('failed');
    }
  }

  function closeDirectCall() {
    if (!directCall) return;
    directCall = null;
    sounds.setRinging(null);
    sfu.close();
    stopTracks(activeMediaStream);
    activeMediaStream = null;
    clearInterval(personalCallTimerTimeout);
    personalCallTimerTimeout = null;
    document.getElementById('self-video').srcObject = null;
    document.getElementById('other-video').srcObject = null;
    calling_audio.srcObject = null;
    const playButton = document.getElementById('personal-play-media');
    playButton.hidden = true;
    playButton.onclick = null;
    $('#personal-call-stage, #private-video-stage, #incoming-call-card').addClass('hide-element');
    $('#audio-call, #video-call').prop('disabled', false);
  }

  function endDirectCall(reason) {
    const id = directCall?.id;
    closeDirectCall();
    if (id && socket.connected) send('call:end', { id, reason });
  }

  $('#accept-call').on('click', async () => {
    const call = directCall;
    if (!call?.incoming) return;
    call.incoming = false;
    $('#incoming-call-card').addClass('hide-element');
    sounds.setRinging(null);
    openPersonalChatForPeer(call.peer.id);
    showDirectStage(call, 'Call with ' + call.peer.name, 'Connecting…');
    try {
      await request('call:accept', { id: call.id });
      if (directCall === call) connectDirectMedia(call);
    } catch (error) {
      if (directCall === call) {
        showError(error.message);
        closeDirectCall();
      }
    }
  });

  socket.on('call:accepted', ({ id }) => {
    if (!directCall || directCall.incoming || (directCall.id && directCall.id !== id)) return;
    directCall.id = id;
    directCall.accepted = true;
    sounds.setRinging(null);
    showDirectStage(directCall, 'Call with ' + directCall.peer.name, 'Connecting…');
    connectDirectMedia(directCall);
  });

  socket.on('call:connected', ({ id }) => {
    if (directCall?.id !== id || personalCallTimerTimeout) return;
    const startedAt = Date.now();
    showTimer('#personal-call-timer', startedAt);
    personalCallTimerTimeout = setInterval(() => showTimer('#personal-call-timer', startedAt), 1000);
  });

  socket.on('call:ended', ({ id, reason }) => {
    if (!directCall || (directCall.id && directCall.id !== id)) return;
    closeDirectCall();
    if (reason === 'no_answer') showError('The call was unanswered.');
    if (reason === 'declined') showError('The call was declined.');
    if (reason === 'failed') showError('The call could not connect.');
  });

  $('#reject-call').on('click', () => endDirectCall('declined'));
  $('#end-call').on('click', () => endDirectCall());
  $('#audio-call').on('click', () => startDirectCall('audio'));
  $('#video-call').on('click', () => startDirectCall('video'));
  $('#personal-toggle-mic').on('click', function () {
    toggleTrack($(this), activeMediaStream, 'private:' + directCall?.id, 'audio');
  });
  $('#personal-toggle-cam').on('click', function () {
    toggleTrack($(this), activeMediaStream, 'private:' + directCall?.id, 'video');
  });

  $('#show-people').on('click', () => setSidebar($('#show-people').attr('aria-expanded') !== 'true'));

  setConnection('Connecting…', false);
  fetch('/api/session', { method: 'POST', signal: AbortSignal.timeout(10000) })
    .then(async (response) => {
      if (!response.ok) throw new Error('Could not start a guest session.');
      ({ guestId } = await response.json());
      socket.connect();
    })
    .catch((error) => {
      setConnection('Connection failed', false);
      showError(error.message + ' Reload this page to try again.');
    });

  // Keyboard shortcut: Escape clears search or dismisses incoming call
  $(document).on('keydown', function (e) {
    if (e.key === 'Escape') {
      if (directCall?.incoming) {
        endDirectCall('declined');
      } else if ($('#show-people').attr('aria-expanded') === 'true') {
        setSidebar(false);
        $('#show-people').trigger('focus');
      } else if ($('#toggle-search-btn').attr('aria-expanded') === 'true') {
        setMobileSearch(false);
        $('#toggle-search-btn').trigger('focus');
      } else if ($('#room-message-search').val()) {
        $('#clear-search-btn').click();
      }
    }
  });
});
