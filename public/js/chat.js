$(async function () {
  'use strict';

  const socket = io({ autoConnect: false });
  let params = JSON.parse(sessionStorage.getItem('nexus_join') || 'null');
  const notificationId = new URLSearchParams(location.search).get('notification');
  let notification;
  let notificationError;
  if (notificationId) {
    try {
      notification = await resolvePushNotification(notificationId);
      params = notification;
    } catch (error) {
      notificationError = error.message;
    }
    history.replaceState(null, '', '/chat.html');
  }
  if (!params?.name || !params?.room) {
    location.replace(notificationError ? '/?notification=unavailable' : '/');
    return;
  }
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const receiptTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
  let personalCallTimerTimeout = null;
  let activeChatMode = 'group';
  let activePrivateUserId = '';
  let activePrivatePeer = null;
  let currentRoomName = params.room;
  let currentUserName = params.name;
  let currentUserStatus = 'online';
  let knownRoomsList = [];
  let groupUnreadCounts = Object.create(null);
  let roomCall = null;
  let roomCallTimerTimeout = null;

  // Message Tracking, Deduplication & Typing
  var rendered_message_ids = new Set();
  var room_typing_users = Object.create(null);
  var roomTypingStopTimeout = null;
  var privateTypingStopTimeout = null;
  var QUICK_REACTIONS = ['👍', '❤️', '🎉', '🚀', '👀'];

  // Personal message history & unread counters
  var user_message_dictionary = Object.create(null);
  var unread_counts = Object.create(null);
  let directPeers = Object.create(null);
  let onlineUsers = [];
  const directThreads = new Map();
  const directHistoryCursors = new Map();
  const loadedDirectHistories = new Set();

  const soundSettingsKey = 'nexus_sound_preferences';
  const soundSettings = document.querySelector('.sound-settings');
  const soundToggles = Array.from(soundSettings.querySelectorAll('input[type="checkbox"]'));
  const volumeSliders = soundSettings.querySelectorAll('input[type="range"]');
  const soundStatus = document.getElementById('sound-settings-status');
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
    for (const input of soundToggles) input.checked = preferences[input.name];
    for (const input of volumeSliders) {
      const value = preferences[input.name];
      input.value = value;
      input.setAttribute('aria-valuetext', value + '%');
      document.getElementById(input.id + '-value').value = value + '%';
    }
    for (const { preference, field } of tonePickers) {
      for (const option of field.querySelectorAll('input[type="radio"]')) option.checked = option.value === preferences[preference];
    }
  }

  function applySoundPreferences() {
    const preferences = {};
    for (const input of soundToggles) preferences[input.name] = input.checked;
    for (const input of volumeSliders) preferences[input.name] = input.valueAsNumber;
    for (const { preference, field } of tonePickers) {
      preferences[preference] = field.querySelector('input[type="radio"]:checked').value;
    }
    sounds.setPreferences(preferences);
    showSoundPreferences();
    soundStatus.textContent = '';
  }

  function saveSoundPreferences() {
    try {
      localStorage.setItem(soundSettingsKey, JSON.stringify(sounds.preferences));
      return true;
    } catch {
      return false;
    }
  }

  showSoundPreferences();
  soundSettings.addEventListener('change', () => {
    applySoundPreferences();
    saveSoundPreferences();
  });
  document.getElementById('reset-sound-settings').addEventListener('click', (event) => {
    sounds.resetPreferences();
    if (event.isTrusted) sounds.enable();
    showSoundPreferences();
    soundStatus.textContent = saveSoundPreferences() ? 'Sound settings reset to defaults.' : 'Sound settings reset for this tab.';
  });
  for (const slider of volumeSliders) slider.addEventListener('input', applySoundPreferences);
  for (const button of soundSettings.querySelectorAll('[data-preview-sound]')) {
    button.addEventListener('click', async () => {
      const kind = button.dataset.previewSound;
      soundStatus.textContent = '';
      if (roomCall || directCall) {
        soundStatus.textContent = 'Sound previews are available after the call.';
      } else if (sounds.volumeFor(kind) === 0) {
        sounds.stopPreview();
        const volumeLabel = document.getElementById(kind + '-volume').labels[0].textContent;
        soundStatus.textContent = 'Raise the ' + volumeLabel.toLowerCase() + ' to preview.';
      } else if (await sounds.preview(kind, button.dataset.tone) === false) {
        soundStatus.textContent = 'Sound playback is unavailable in this tab.';
      }
    });
  }
  soundSettings.addEventListener('toggle', () => {
    if (!soundSettings.open) {
      sounds.stopPreview();
      soundStatus.textContent = '';
    }
  });
  window.addEventListener('storage', ({ key }) => {
    if (key !== soundSettingsKey && key !== null) return;
    sounds.setPreferences(readSoundPreferences());
    showSoundPreferences();
    soundStatus.textContent = '';
  });
  for (const eventName of ['click', 'keydown']) {
    document.addEventListener(eventName, (event) => {
      if (event.isTrusted && soundToggles.some((input) => input.checked)) sounds.enable();
    }, { capture: true });
  }
  window.addEventListener('pagehide', () => {
    sounds.setRinging(null);
    sounds.stopMessage();
    sounds.stopPreview();
    leaveRoomSfuCall();
    endDirectCall();
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
        $('#personal-empty-title').text('Direct Message with ' + activePrivatePeer.name);
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
    if (!open) scheduleDirectRead();
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
  const pendingDirectHistories = new Map();
  const directReadsInFlight = new Map();
  let directReadTimer;
  const replyTargets = { group: null, personal: null };

  function summarizeMessage(message) {
    const text = message.type === 'text' ? message.text :
      message.type === 'file' ? message.filename :
      message.type === 'location' ? 'Shared location' :
      message.mode === 'video' ? 'Video call' : 'Audio call';
    return { from: message.from, text: Array.from(text).slice(0, 160).join('') };
  }

  function directMessageSubtitle(user) {
    const latest = directThreads.get(user.guestId)?.latest;
    if (!latest) return { online: 'Online', offline: 'Offline', away: 'Away', dnd: 'Do Not Disturb' }[user.status];
    return (latest.authorId === guestId ? 'You: ' : '') + latest.text;
  }

  function updateDirectThread(peer, thread) {
    const id = peer.guestId;
    directThreads.set(id, { peer, ...thread });
    unread_counts[id] = thread.unread;
    const user = directPeers[id];
    if (!user) {
      renderDirectSidebar();
      return;
    }
    if (!user.id && user.name !== peer.name && peer.name) {
      renderDirectSidebar();
      return;
    }
    updateUnreadBadgeDOM(id);
    $('#users li.user-list').filter((_, row) => row.dataset.userId === id)
      .find('.user-secondary-status').text(directMessageSubtitle(user));
  }

  function setReplyTarget(mode, target) {
    replyTargets[mode] = target;
    const composer = $(mode === 'personal' ? '#private-reply-composer' : '#group-reply-composer');
    composer.prop('hidden', !target);
    composer.find('.reply-composer__label').text(target ? 'Replying to ' + target.from : '');
    composer.find('.reply-composer__text').text(target?.text || '');
  }

  $('#group-reply-composer .reply-composer__cancel').on('click', () => {
    setReplyTarget('group', null);
    $('#message-input').trigger('focus');
  });
  $('#private-reply-composer .reply-composer__cancel').on('click', () => {
    setReplyTarget('personal', null);
    $('#private-message-input').trigger('focus');
  });
  function saveDirectDraft() {
    if (activePrivatePeer) directDrafts.set(activePrivatePeer.guestId, $('#private-message-input').val());
  }

  function switchToGroupChatCanvas() {
    saveDirectDraft();
    setReplyTarget('personal', null);
    activeChatMode = 'group';
    activePrivateUserId = '';
    activePrivatePeer = null;

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
    $('#header-chat-subtitle').text('Group chat').removeClass('header-chat-subtitle--unavailable');
    $('#back-to-group-btn').addClass('hide-element');

    // Toggle Header Call Action Buttons
    $('#group-header-call-actions').removeClass('hide-element');
    $('#personal-header-call-actions').addClass('hide-element');

    // Toggle Canvas Views
    $('#personal-chat-canvas').addClass('hide-element');
    $('#group-chat-canvas').removeClass('hide-element');
    resizeComposer(document.getElementById('message-input'));

    updateSidebarActiveHighlights();
    updateEmptyStates();
    applySearchFilter();

    var $msgList = $('#messages');
    if ($msgList.length) {
      $msgList.scrollTop($msgList.prop('scrollHeight') || 0);
    }
  }

  function switchToPersonalChatCanvas(userId, userName) {
    if (!userId || userId === guestId) return;

    var peerUser = directPeers[userId];
    var resolvedName = userName || (peerUser && peerUser.name) || 'Personal Chat';
    var peerStatus = (peerUser && peerUser.status) || 'online';
    saveDirectDraft();
    if (peerUser.guestId !== activePrivatePeer?.guestId) setReplyTarget('personal', null);
    $('#private-message-input').val(directDrafts.get(peerUser?.guestId) || '');
    activeChatMode = 'personal';
    activePrivateUserId = userId;
    activePrivatePeer = peerUser;

    $('#private-typing-indicator').addClass('hide-element').text('');

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
    showDirectPresence(peerStatus);
    $('#back-to-group-label').text('Back to #' + currentRoomName);
    $('#back-to-group-btn').removeClass('hide-element');

    // Toggle Header Call Buttons
    $('#group-header-call-actions').addClass('hide-element');
    $('#personal-header-call-actions').removeClass('hide-element');

    // Toggle Canvas Views
    $('#group-chat-canvas').addClass('hide-element');
    $('#personal-chat-canvas').removeClass('hide-element');
    resizeComposer(document.getElementById('private-message-input'));

    renderPrivateMessages(userId);
    updateDirectAvailability();
    updateSidebarActiveHighlights();
    updateEmptyStates();
    applySearchFilter();

    setSidebar(false);
  }

  function showDirectPresence(status) {
    const labels = { online: 'Active now', offline: 'Offline', away: 'Away', dnd: 'Do Not Disturb' };
    $('#header-status-dot').attr('class', 'room-status-dot status-' + status);
    $('#header-avatar-status-dot').attr('class', 'header-avatar-status-dot status-' + status);
    $('#header-chat-subtitle').text(labels[status]).toggleClass('header-chat-subtitle--unavailable', status === 'offline' || status === 'dnd');
  }

  function updateDirectAvailability() {
    const peer = directPeers[getActivePrivateUserId()];
    const canSend = ready && Boolean(peer);
    const canCall = canSend && peer.status !== 'dnd' && !directCall && !roomCall;
    $('#private-send-btn, #private-send-file-click, #private-send-location, #private_messages_list .message-toolbar button')
      .each((_, button) => { button.disabled = !canSend || button.getAttribute('aria-busy') === 'true'; });
    $('#audio-call, #video-call, #private_messages_list .call-again-btn').prop('disabled', !canCall);
    $('#direct-history-actions').toggleClass('hide-element', !directHistoryCursors.has(peer?.guestId));
    $('#load-older-direct').prop('disabled', !canSend || pendingDirectHistories.has(peer?.guestId));
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

  const gridHelpers = { getInitials, getAvatarStyle, playRemoteMedia };
  const roomGrid = new CallGrid(document.getElementById('room-call-stage'), gridHelpers);
  const personalGrid = new CallGrid(document.getElementById('personal-call-stage'), gridHelpers);
  const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());
  const roomSessionId = () => 'room:chat:' + currentRoomName.toLowerCase();

  function updateRoomCallStatus(participants) {
    $('#room-call-count').text(String(participants.length));
    $('#room-call-active-badge').toggleClass('hide-element', participants.length === 0);
  }

  function updateShareButton(scope, presentation) {
    const button = $('#' + scope + '-toggle-screen');
    const active = Boolean(presentation?.stream && !presentation.pending);
    const label = active ? 'Stop sharing' : presentation?.pending ? 'Please wait…' :
      presentation?.available === false ? 'Sharing unavailable' : 'Share screen';
    button.prop('disabled', !presentation?.available || presentation.pending)
      .toggleClass('call-share-button--active', active)
      .attr('aria-pressed', String(active))
      .attr('title', presentation?.available === false ? 'Screen sharing is unavailable in this browser' : label);
    button.find('span').text(label);
    button.find('i').attr('class', active ? 'fa-solid fa-stop' : 'fa-solid fa-desktop');
  }

  async function startCallMedia(call, { scope, grid, isCurrent, onConnected, onError }) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.mode === 'video' });
    if (!isCurrent()) return stopTracks(stream);
    call.stream = stream;
    call.grid = grid;
    call.self = {
      name: currentUserName, streamId: 'local-self', screenStreamId: 'local-screen',
      audioEnabled: true, videoEnabled: call.mode === 'video', screenSharing: false,
    };
    grid.setStream(call.self.streamId, stream);
    grid.update(call.self, true);
    const media = await sfu.start(call.sessionId, call.mode, stream, {
      onParticipants: (participants) => {
        if (!isCurrent()) return;
        for (const participant of participants) {
          if (participant.socketId !== socket.id) grid.update(participant);
        }
      },
      onTrack: ({ streams: [remote] }) => {
        if (isCurrent() && remote) grid.setStream(remote.id, remote);
      },
      onConnected,
      onError,
    });
    if (!media || !isCurrent()) return;
    call.presentation = new CallPresentation(
      media.screenSender,
      async (screenSharing) => {
        const payload = { sessionId: call.sessionId, screenSharing };
        try {
          await request('sfu:media-state', payload);
        } catch (error) {
          if (screenSharing || !isCurrent()) throw error;
          try {
            await request('sfu:media-state', payload);
          } catch (stopError) {
            if (isCurrent()) onError('The call ended because screen sharing could not be stopped remotely.');
            throw stopError;
          }
        }
      },
      (capture) => {
        call.self.screenSharing = Boolean(capture);
        grid.setStream(call.self.screenStreamId, capture);
        grid.update(call.self, true);
        updateShareButton(scope, call.presentation);
      },
      (error) => { if (isCurrent()) showError(error.message); },
    );
    $('#' + scope + '-toggle-mic, #' + scope + '-toggle-cam').prop('disabled', false);
    updateShareButton(scope, call.presentation);
  }

  async function joinRoomSfuCall(mode) {
    if (!ready || switching || roomCall) return;
    if (directCall) return showError('End your direct call before joining a group call.');
    const call = { sessionId: roomSessionId(), mode };
    roomCall = call;
    updateDirectAvailability();
    sounds.stopMessage();
    sounds.stopPreview();
    $('#join-room-audio-btn, #join-room-video-btn').prop('disabled', true);
    $('#room-call-mode-label').text(currentRoomName + ' · ' + (mode === 'video' ? 'Video call' : 'Audio call'));
    $('#room-call-timer').text('Connecting…');
    $('#room-call-stage').removeClass('hide-element');
    $('#room-toggle-cam').toggleClass('hide-element', mode === 'audio');
    resetMediaButtons('room');
    const onError = (message) => {
      if (roomCall !== call) return;
      showError(message);
      leaveRoomSfuCall();
    };
    try {
      await startCallMedia(call, {
        scope: 'room',
        grid: roomGrid,
        isCurrent: () => roomCall === call,
        onConnected: () => {
          if (roomCall !== call || roomCallTimerTimeout) return;
          const startedAt = Date.now();
          showTimer('#room-call-timer', startedAt);
          roomCallTimerTimeout = setInterval(() => showTimer('#room-call-timer', startedAt), 1000);
        },
        onError,
      });
    } catch (error) {
      onError(error.message);
    }
  }

  function closeCallMedia(call, grid) {
    call.presentation?.close();
    sfu.close();
    stopTracks(call.stream);
    grid.clear();
  }

  function leaveRoomSfuCall(notify = true) {
    if (!roomCall) return;
    const call = roomCall;
    roomCall = null;
    closeCallMedia(call, roomGrid);
    if (notify && socket.connected) send('sfu:leave', { sessionId: call.sessionId });
    updateDirectAvailability();
    clearInterval(roomCallTimerTimeout);
    roomCallTimerTimeout = null;
    $('#room-call-stage').addClass('hide-element');
    $('#join-room-audio-btn, #join-room-video-btn').prop('disabled', false);
    resetMediaButtons('room');
  }

  socket.on('sfu:participant-left', ({ sessionId, streamId, screenStreamId }) => {
    const call = roomCall || directCall;
    if (call?.sessionId === sessionId) call.grid?.removePerson(streamId, screenStreamId);
  });

  socket.on('sfu:media-state', (state) => {
    const call = roomCall || directCall;
    if (call?.sessionId === state.sessionId && state.socketId !== socket.id) call.grid?.update(state);
  });

  socket.on('sfu:room-call-status', ({ sessionId, participants }) => {
    if (sessionId === roomSessionId()) updateRoomCallStatus(participants);
  });

  $('#join-room-audio-btn').on('click', () => joinRoomSfuCall('audio'));
  $('#join-room-video-btn').on('click', () => joinRoomSfuCall('video'));
  $('#room-leave-call').on('click', () => leaveRoomSfuCall());
  $('#room-toggle-screen').on('click', () => roomCall?.presentation?.toggle());
  $('#personal-toggle-screen').on('click', () => directCall?.presentation?.toggle());

  function resetMediaButtons(scope) {
    for (const [control, icon, label] of [
      ['mic', 'microphone', 'Mute microphone'], ['cam', 'video', 'Turn camera off'],
    ]) {
      $('#' + scope + '-toggle-' + control).prop('disabled', true)
        .removeClass('muted-state').attr({ 'aria-pressed': 'false', title: label })
        .find('i').attr('class', 'fa-solid fa-' + icon);
    }
    updateShareButton(scope, null);
  }

  function toggleTrack(button, call, kind) {
    const tracks = kind === 'audio' ? call?.stream?.getAudioTracks() : call?.stream?.getVideoTracks();
    if (!tracks?.length) return;
    const enabled = !tracks[0].enabled;
    for (const track of tracks) track.enabled = enabled;
    const isAudio = kind === 'audio';
    const icon = isAudio ? 'microphone' : 'video';
    const title = isAudio ? (enabled ? 'Mute microphone' : 'Unmute microphone') :
      (enabled ? 'Turn camera off' : 'Turn camera on');
    button.toggleClass('muted-state', !enabled).attr({ 'aria-pressed': String(!enabled), title });
    button.find('i').attr('class', 'fa-solid fa-' + icon + (enabled ? '' : '-slash'));
    const setting = kind + 'Enabled';
    call.self[setting] = enabled;
    call.grid.update(call.self, true);
    send('sfu:media-state', { sessionId: call.sessionId, [setting]: enabled });
  }

  $('#room-toggle-mic').on('click', function () { toggleTrack($(this), roomCall, 'audio'); });
  $('#room-toggle-cam').on('click', function () { toggleTrack($(this), roomCall, 'video'); });

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
    scheduleDirectRead();
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

  const messageTemplates = {
    text: '#message-template',
    file: '#file-message-template',
    location: '#location-message-template',
    call: '#call-message-template',
  };

  function buildMessage(message, peerId) {
    const isMine = message.authorId === guestId;
    const view = {
      from: message.from,
      text: message.text,
      url: message.url,
      filename: message.filename,
      createdAt: time.format(message.createdAt),
      initials: getInitials(message.from),
      extraClass: [
        peerId && message.type === 'text' ? 'message--private' : '',
        isMine ? 'message--outgoing' : peerId ? 'message--incoming' : '',
      ].join(' '),
    };

    if (message.type === 'call') {
      const video = message.mode === 'video';
      const type = video ? 'video call' : 'audio call';
      const missed = !isMine && !message.wasAnswered && !message.wasConnected &&
        ['no_answer', 'cancelled', 'left'].includes(message.reason);
      const outcomes = { declined: 'Declined', no_answer: 'No answer', left: 'Participant left', failed: 'Connection failed' };
      const duration = message.wasConnected ? formatCallDuration(message.durationSec) : outcomes[message.reason] || 'Cancelled';
      Object.assign(view, {
        callTitle: missed ? 'Missed ' + type : (isMine ? 'Outgoing ' : 'Incoming ') + type,
        callAction: isMine ? 'Call again' : 'Call back',
        callDuration: missed ? 'Unanswered' : duration,
        callIcon: video ? 'fa-solid fa-video' : 'fa-solid fa-phone',
        callStatusClass: message.wasConnected ? 'call-status--completed' : 'call-status--missed',
      });
    }

    const $item = $(Mustache.render($(messageTemplates[message.type]).html(), view));
    $item.find('.message__avatar').attr('style', getAvatarStyle(message.from));
    if (message.type === 'call') {
      $item.find('.call-again-btn').on('click', () => startDirectCall(message.mode));
    }
    decorateMessage($item, message, peerId);
    if (peerId && isMine && message.type !== 'call') {
      const $receipt = $('<span class="direct-message-receipt"></span>');
      updateReceiptLabel($receipt, message.readAt);
      $item.find('.message__content').append($receipt);
    }
    return $item;
  }

  function renderPrivateMessages(userId, preserveScroll = false) {
    const $list = $('#private_messages_list');
    const list = $list[0];
    const bottomOffset = list.scrollHeight - list.scrollTop;
    $list.empty();
    for (const message of user_message_dictionary[userId] || []) {
      $list.append(buildMessage(message, userId));
    }
    updateEmptyStates();
    applySearchFilter();
    list.scrollTop = preserveScroll ? list.scrollHeight - bottomOffset : list.scrollHeight;
    scheduleDirectRead();
  }

  function appendDirectMessage(userId, message) {
    const $list = $('#private_messages_list');
    const list = $list[0];
    const follow = message.authorId === guestId || list.scrollHeight - list.scrollTop - list.clientHeight < 100;
    $list.append(buildMessage(message, userId));
    updateEmptyStates();
    applySearchFilter();
    if (follow) list.scrollTop = list.scrollHeight;
    scheduleDirectRead();
  }

  $('#dismiss-alert').on('click', function (e) {
    e.preventDefault();
    $('#alert-box').addClass('alert-hide');
  });

  // Reactions & message toolbar builder
  function renderMessageReactions($li, messageId, reactions, peerId) {
    var $bar = $li.find('.reaction-bar');
    if (!$bar.length) return;
    $bar.empty();

    var reactionMap = reactions || {};
    const counts = QUICK_REACTIONS.filter((emoji) => reactionMap[emoji]?.length)
      .map((emoji) => emoji + ' ' + reactionMap[emoji].length).join(' ');
    $li.find('summary').attr('aria-label', counts ? 'Reactions, ' + counts : 'Add reaction');
    $li.find('.reaction-summary').text(counts);
    QUICK_REACTIONS.forEach(function (emoji) {
      var usersList = Array.isArray(reactionMap[emoji]) ? reactionMap[emoji] : [];
      var count = usersList.length;
      var isMine = usersList.some((reaction) => reaction.authorId === guestId);

      var $btn = $('<button type="button" class="reaction-btn"></button>');
      if (isMine) $btn.addClass('active-reaction');
      $btn.attr({ 'aria-pressed': String(isMine), 'aria-label': 'React with ' + emoji });
      $btn.text(count > 0 ? emoji + ' ' + count : emoji);
      if (count > 0) {
        $btn.attr('title', usersList.map((reaction) => reaction.name).join(', '));
      }
      $btn.on('click', function (e) {
        e.preventDefault();
        const picker = $bar.closest('details').prop('open', false);
        picker.find('summary').trigger('focus');
        send('message:reaction', {
          messageId: messageId,
          emoji: emoji,
          peerId,
        });
      });
      $bar.append($btn);
    });
  }

  function updateQuote($quote, reply) {
    $quote.prop('disabled', !reply);
    $quote.find('strong').text(reply?.from || 'Message unavailable');
    $quote.find('span').text(reply?.text || '');
  }

  function decorateMessage($item, message, peerId) {
    $item.attr('data-message-id', message.id);
    if (message.edited) $item.find('.user-time').after('<span class="edited-tag">(edited)</span>');

    const mode = peerId ? 'personal' : 'group';
    const list = peerId ? '#private_messages_list' : '#messages';
    if (message.replyTo) {
      const $quote = $('<button type="button" class="message-quote"><strong></strong><span></span></button>')
        .attr('data-reply-to', message.replyTo);
      updateQuote($quote, message.reply);
      $quote.on('click', () => {
        const target = $(list + ' > li').filter((_, row) => row.dataset.messageId === message.replyTo)[0];
        if (!target) {
          if (peerId && directHistoryCursors.has(peerId)) showError('Load older messages to jump to the original.');
          return;
        }
        if (target.classList.contains('hide-element')) $('#room-message-search').val('').trigger('input');
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'center' });
      });
      $item.find('.message__body').before($quote);
    }

    const $toolbar = $('<div class="message-toolbar"></div>');
    if (message.type !== 'call') {
      $toolbar.append('<details class="message-reactions"><summary aria-label="Reactions"><i class="fa-regular fa-face-smile" aria-hidden="true"></i> <span class="reaction-summary"></span></summary><div class="reaction-bar"></div></details>');
    }
    const $actions = $('<div class="msg-owner-actions"></div>');
    const $reply = $('<button type="button" class="msg-action-btn" title="Reply" aria-label="Reply"><i class="fa-solid fa-reply" aria-hidden="true"></i></button>');
    $reply.on('click', () => {
      const current = peerId && user_message_dictionary[peerId]?.find((item) => item.id === message.id);
      const quote = summarizeMessage(current || message);
      if (!peerId && message.type === 'text') {
        quote.text = Array.from($item.find('.message__body p').text()).slice(0, 160).join('');
      }
      setReplyTarget(mode, { id: message.id, ...quote });
      $(peerId ? '#private-message-input' : '#message-input').trigger('focus');
    });
    $actions.append($reply);
    if (message.authorId === guestId && message.type !== 'call') {
      if (message.type === 'text') {
        const $edit = $('<button type="button" class="msg-action-btn" title="Edit message" aria-label="Edit message"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>');
        $edit.on('click', () => openMessageDialog(message.id, $item.find('.message__body p').text(), peerId));
        $actions.append($edit);
      }
      const $delete = $('<button type="button" class="msg-action-btn msg-action-delete" title="Delete message" aria-label="Delete message"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>');
      $delete.on('click', () => openMessageDialog(message.id, undefined, peerId));
      $actions.append($delete);
    }
    $item.find('.message__content').append($toolbar.append($actions));
    renderMessageReactions($item, message.id, message.reactions, peerId);
  }

  function appendRoomMessageItem(message, isHistoryReplay) {
    if (!message) return;
    if (message.id && rendered_message_ids.has(message.id)) return;
    if (message.id) {
      rendered_message_ids.add(message.id);
    }

    const isMine = message.authorId === guestId;
    $('#messages').append(buildMessage(message));
    const items = $('#messages > li');
    if (items.length > historyLimit) {
      const expiredId = items.first().attr('data-message-id');
      rendered_message_ids.delete(expiredId);
      items.first().remove();
      updateTimelineQuotes('#messages', expiredId, null);
      refreshReplyTarget('group', 'deleted', { messageId: expiredId });
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

  function openMessageDialog(id, text, peerId) {
    const editing = text !== undefined;
    dialogMessage = { id, editing, peerId, room: currentRoomName };
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
    const pending = dialogMessage;
    const { id, editing, room, peerId } = pending;
    const text = $('#message-edit-input').val().trim();
    if (!ready || switching || room !== currentRoomName || (editing && !text)) return;
    if (peerId && getActivePrivateUserId() !== peerId) {
      dialog.close();
      return;
    }
    $('#message-dialog-submit').prop('disabled', true);
    try {
      await request(editing ? 'message:edit' : 'message:delete', { messageId: id, peerId, text });
      if (dialogMessage !== pending || !dialog.open) return;
      dialog.close();
      document.getElementById(peerId ? 'private-message-input' : 'message-input').focus({ preventScroll: true });
    } catch (error) {
      if (dialogMessage !== pending || !dialog.open) return;
      $('#message-dialog-status').text(error.message);
      $('#message-dialog-submit').prop('disabled', false);
    }
  });

  socket.on('updateRoomList', function (rooms) {
    knownRoomsList = rooms.slice();
    ensureRoomInKnownList(currentRoomName);
    renderGroupsSidebar();
  });

  function updateDirectMessages(messages, event, data) {
    if (event === 'new') {
      if (messages.some((message) => message.id === data.message.id)) return messages;
      return [...messages, data.message];
    }
    if (event === 'read') {
      const reads = new Map(data.receipts.map(({ id, readAt }) => [id, readAt]));
      return messages.map((message) => reads.has(message.id) ? { ...message, readAt: reads.get(message.id) } : message);
    }
    const { messageId, text, editedAt, reactions, quote } = data;
    const next = event === 'deleted' ? messages.filter((message) => message.id !== messageId) : messages;
    return next.map((message) => {
      if (message.id === messageId) {
        if (event === 'edited') return { ...message, text, editedAt, edited: true };
        if (event === 'reaction-updated') return { ...message, reactions };
      }
      if (message.replyTo === messageId && event !== 'reaction-updated') {
        return { ...message, reply: event === 'edited' ? quote : null };
      }
      return message;
    });
  }

  function applyDirectEvent(peerId, event, data) {
    pendingDirectHistories.get(peerId)?.push({ event, data });
    const current = user_message_dictionary[peerId] || [];
    const updated = updateDirectMessages(current, event, data);
    user_message_dictionary[peerId] = updated;
    return updated !== current;
  }

  function updateReceiptLabel(label, readAt) {
    label.text(readAt ? 'Seen · ' + time.format(readAt) : 'Sent');
    if (readAt) label.attr('title', 'Seen ' + receiptTime.format(readAt));
  }

  function applyDirectReceipts(id, receipts) {
    if (!receipts.length) return;
    applyDirectEvent(id, 'read', { receipts });
    if (getActivePrivateUserId() !== id) return;
    const reads = new Map(receipts.map(({ id: messageId, readAt }) => [messageId, readAt]));
    $('#private_messages_list > li').each((_, row) => {
      const readAt = reads.get(row.dataset.messageId);
      if (readAt) updateReceiptLabel($(row).find('.direct-message-receipt'), readAt);
    });
  }

  socket.on('dm:read', ({ peer, thread, receipts }) => {
    updateDirectThread(peer, thread);
    applyDirectReceipts(peer.guestId, receipts);
  });

  function scheduleDirectRead() {
    if (directReadTimer || activeChatMode !== 'personal') return;
    directReadTimer = setTimeout(markVisibleDirectMessages, 160);
  }

  async function markVisibleDirectMessages() {
    directReadTimer = null;
    const id = getActivePrivateUserId();
    if (!ready || switching || !id || directReadsInFlight.has(id) || document.hidden || !document.hasFocus() ||
        dialog.open || $('#show-people').attr('aria-expanded') === 'true') return;

    const list = document.getElementById('private_messages_list');
    const viewport = list.getBoundingClientRect();
    const top = Math.max(0, viewport.top);
    const bottom = Math.min(window.innerHeight, viewport.bottom);
    if (bottom <= top) return;
    const unread = new Set((user_message_dictionary[id] || [])
      .filter((message) => message.authorId === id && !message.readAt).map((message) => message.id));
    const visible = Array.from(list.children).filter((row) => {
      if (!unread.has(row.dataset.messageId) || row.classList.contains('hide-element')) return false;
      const bounds = row.getBoundingClientRect();
      const overlap = Math.min(bounds.bottom, bottom) - Math.max(bounds.top, top);
      return bounds.height > 0 && overlap >= Math.min(bounds.height, bottom - top) / 2;
    });
    const messageIds = visible.slice(0, 50).map((row) => row.dataset.messageId);
    if (!messageIds.length) return;
    const batch = {};
    directReadsInFlight.set(id, batch);
    let receipts;
    try {
      receipts = await request('dm:read', { peerId: id, messageIds });
      if (directReadsInFlight.get(id) === batch) applyDirectReceipts(id, receipts);
    } catch {
      // A later view or reconnect reads the server's current receipt state.
    } finally {
      if (directReadsInFlight.get(id) === batch) directReadsInFlight.delete(id);
      if (receipts?.length) scheduleDirectRead();
    }
  }

  document.getElementById('private_messages_list').addEventListener('scroll', scheduleDirectRead, { passive: true });
  document.addEventListener('visibilitychange', scheduleDirectRead);
  dialog.addEventListener('close', scheduleDirectRead);
  window.addEventListener('focus', scheduleDirectRead);
  window.addEventListener('resize', scheduleDirectRead);

  function refreshReplyTarget(mode, event, { messageId, quote }) {
    const target = replyTargets[mode];
    if (target?.id !== messageId) return;
    if (event === 'deleted') setReplyTarget(mode, null);
    if (event === 'edited') setReplyTarget(mode, { id: messageId, ...quote });
  }

  function updateTimelineQuotes(list, messageId, quote) {
    $(list + ' .message-quote').filter((_, button) => button.dataset.replyTo === messageId)
      .each((_, button) => updateQuote($(button), quote));
  }

  for (const event of ['edited', 'deleted', 'reaction-updated']) {
    socket.on('message:' + event, (data) => {
      if (!data?.messageId) return;
      if (data.peer) {
        const peerId = data.peer.guestId;
        updateDirectThread(data.peer, data.thread);
        applyDirectEvent(peerId, event, data);
        if (getActivePrivateUserId() !== peerId) return;
      }
      const mode = data.peer ? 'personal' : 'group';
      const list = data.peer ? '#private_messages_list' : '#messages';
      const $item = $(list + ' > li').filter((_, row) => row.dataset.messageId === data.messageId);
      refreshReplyTarget(mode, event, data);
      if (event === 'deleted') {
        if (!data.peer) rendered_message_ids.delete(data.messageId);
        $item.remove();
        updateTimelineQuotes(list, data.messageId, null);
        updateEmptyStates();
      } else if (event === 'edited') {
        $item.find('.message__body p').text(data.text);
        if (!$item.find('.edited-tag').length) $item.find('.user-time').after('<span class="edited-tag">(edited)</span>');
        updateTimelineQuotes(list, data.messageId, data.quote);
        if (activeChatMode === mode) applySearchFilter();
      } else {
        renderMessageReactions($item, data.messageId, data.reactions, data.peer?.guestId);
      }
    });
  }

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
    const mode = privateUpload ? 'personal' : 'group';
    const reply = replyTargets[mode];
    if (!ready || switching || (privateUpload && !directPeers[peer])) return showError('Open a conversation before sharing files.');
    if (file.size > 50 * 1024 * 1024) return showError('Files must be 50 MB or smaller.');

    const data = new FormData();
    data.append('file', file);
    const progress = document.getElementById(privateUpload ? 'private-upload-progress-bar' : 'upload-progress-bar');
    const bar = progress.firstElementChild;
    const button = $(privateUpload ? '#private-send-file-click' : '#send-file').prop('disabled', true).attr('aria-busy', 'true');
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
    if (reply) xhr.setRequestHeader('X-Chat-Reply-To', reply.id);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) setProgress(Math.round(100 * event.loaded / event.total));
    });
    xhr.addEventListener('loadend', () => {
      button.prop('disabled', false).removeAttr('aria-busy');
      if (privateUpload) updateDirectAvailability();
      progress.classList.add('hide-element');
      if (xhr.status !== 201) showError(xhr.response?.error || 'The upload could not be confirmed. Check the conversation before retrying.');
      else if (reply && replyTargets[mode] === reply) setReplyTarget(mode, null);
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
    updateDirectAvailability();
  }

  socket.on('room:state', ({ user, users, messages, participants, directThreads: threads, historyLimit: limit }) => {
    historyLimit = limit;
    if (roomCall && roomCall.sessionId !== 'room:chat:' + user.room.toLowerCase()) leaveRoomSfuCall(false);
    if (dialog.open) dialog.close();
    const sameRoom = currentRoomName.toLowerCase() === user.room.toLowerCase();
    const previousPeer = sameRoom ? activePrivatePeer?.guestId : null;
    if (!sameRoom) {
      $('#message-input, #private-message-input').val('');
      setReplyTarget('group', null);
    }
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
    pendingDirectHistories.clear();
    directReadsInFlight.clear();
    unread_counts = Object.create(null);
    directThreads.clear();
    directHistoryCursors.clear();
    loadedDirectHistories.clear();
    for (const thread of threads) {
      directThreads.set(thread.peer.guestId, thread);
      unread_counts[thread.peer.guestId] = thread.unread;
    }
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
    if (notification) {
      openPersonalChatForPeer(notification.peerId, false);
      notification = null;
    } else if (directPeers[previousPeer]) {
      openPersonalChatForPeer(previousPeer, false);
    }
    if (notificationError) {
      showError(notificationError);
      notificationError = null;
    }
  });

  const foreground = () => !document.hidden && document.hasFocus();
  function reportVisibility(event) {
    if (ready && socket.connected) {
      socket.emit('push:visibility', { foreground: event.type !== 'pagehide' && event.type !== 'blur' && foreground() });
    }
  }
  document.addEventListener('visibilitychange', reportVisibility);
  for (const event of ['focus', 'blur', 'pagehide']) window.addEventListener(event, reportVisibility);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async ({ data }) => {
      if (!data?.notificationId) return;
      try {
        const target = await resolvePushNotification(data.notificationId);
        if (!ready) {
          location.assign('/chat.html?notification=' + data.notificationId);
          return;
        }
        if (target.room.toLowerCase() !== currentRoomName.toLowerCase()) {
          if (switching || directCall || roomCall) throw new Error('Open this notification after leaving the current call or group switch.');
          switching = true;
          try {
            await request('room:switch', { room: target.room });
          } finally {
            switching = false;
          }
        }
        openPersonalChatForPeer(target.peerId, false);
      } catch (error) {
        showError(error.message);
      }
    });
  }

  socket.on('connect', async () => {
    setConnection('Joining…', false);
    try {
      await request('join', { name: currentUserName, room: currentRoomName, foreground: foreground() });
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

  async function loadDirectHistory(id, before) {
    if (pendingDirectHistories.has(id)) return;
    const queued = [];
    pendingDirectHistories.set(id, queued);
    updateDirectAvailability();
    try {
      const page = await request('dm:history', { peerId: id, before });
      if (pendingDirectHistories.get(id) !== queued) return;
      const merged = new Map(page.messages.map((message) => [message.id, message]));
      if (before !== undefined) {
        for (const message of user_message_dictionary[id] || []) merged.set(message.id, message);
      }
      user_message_dictionary[id] = queued.reduce((messages, update) =>
        updateDirectMessages(messages, update.event, update.data), Array.from(merged.values()));
      if (page.before === null) directHistoryCursors.delete(id);
      else directHistoryCursors.set(id, page.before);
      loadedDirectHistories.add(id);
      if (getActivePrivateUserId() === id) renderPrivateMessages(id, before !== undefined);
    } catch (error) {
      if (getActivePrivateUserId() === id) showError(error.message);
    } finally {
      if (pendingDirectHistories.get(id) === queued) pendingDirectHistories.delete(id);
      updateDirectAvailability();
    }
  }

  function openPersonalChatForPeer(id, focus = true) {
    const peer = directPeers[id];
    if (!ready || switching || !peer || id === guestId) return;
    const active = getActivePrivateUserId() === id;
    if (!active) switchToPersonalChatCanvas(id, peer.name);
    if (focus) $('#private-message-input').trigger('focus');
    if (!active || !loadedDirectHistories.has(id)) loadDirectHistory(id);
  }

  $('#load-older-direct').on('click', () => {
    const id = getActivePrivateUserId();
    if (ready && !switching && directHistoryCursors.has(id)) loadDirectHistory(id, directHistoryCursors.get(id));
  });

  function renderDirectSidebar() {
    const peers = Object.create(null);
    for (const { peer } of directThreads.values()) {
      peers[peer.guestId] = { ...peer, id: null, name: peer.name || 'Guest', status: 'offline' };
    }
    for (const user of onlineUsers) {
      if (user.guestId === guestId && user.id !== socket.id) continue;
      const thread = directThreads.get(user.guestId);
      if (thread) thread.peer.name = user.name;
      peers[user.guestId] = user;
    }
    directPeers = peers;
    const active = getActivePrivateUserId();
    if (active && !peers[active]) {
      if (dialog.open) dialog.close();
      switchToGroupChatCanvas();
    } else if (active) {
      activePrivatePeer = peers[active];
      $('#header-room-title').text(activePrivatePeer.name);
      showDirectPresence(activePrivatePeer.status);
    }

    const ordered = Object.values(peers).sort((a, b) =>
      (a.guestId === guestId) - (b.guestId === guestId) ||
      (directThreads.get(b.guestId)?.latest?.createdAt || 0) - (directThreads.get(a.guestId)?.latest?.createdAt || 0) ||
      a.name.localeCompare(b.name));
    const $list = $('<ol></ol>');
    for (const user of ordered) {
      const id = user.guestId;
      const self = id === guestId;
      const displayName = self ? user.name + ' (You)' : user.name;
      const $item = $('<li class="user-list"></li>').attr('data-user-id', id).toggleClass('user-list--self', self);
      const $avatar = $('<div class="user-avatar-badge user-avatar-badge--sm"></div>')
        .attr('style', getAvatarStyle(user.name)).text(getInitials(user.name));
      const $dot = $('<span class="user-avatar-status-dot"></span>').addClass('status-' + user.status);
      const $avatarWrap = $('<div class="sidebar-item-avatar-wrap"></div>').append($avatar, $dot);
      const $info = $('<div class="user-list__name"></div>').append(
        $('<span class="user-primary-name"></span>').text(displayName),
        $('<span class="user-secondary-status"></span>').text(directMessageSubtitle(user)));
      $item.append($('<div class="user-row-flex"></div>').append($avatarWrap, $info));
      if (!self) {
        const $badge = $('<span class="new-message"></span>').attr('data-user-id', id);
        const unread = unread_counts[id] || 0;
        if (unread) $badge.css('display', 'inline-block').text(String(unread));
        const $button = $('<button type="button" class="btn-chat-trigger"><i class="fa-regular fa-comment-dots" aria-hidden="true"></i></button>')
          .attr('aria-label', 'Message ' + user.name);
        $item.append($('<div class="user-list__actions"></div>').append($badge, $button));
        $item.on('click', () => openPersonalChatForPeer(id));
      }
      $list.append($item);
    }
    $('#users').empty().append($list);
    updateSidebarActiveHighlights();
    updateDirectAvailability();
  }

  function updateUsers(users) {
    if (!Array.isArray(users)) return;
    onlineUsers = users;
    $('#online-count').text(String(new Set(users.filter((user) => user.guestId !== guestId).map((user) => user.guestId)).size));
    renderDirectSidebar();
    renderGroupsSidebar();
  }
  socket.on('updateUserList', updateUsers);

  socket.on('newMessage', (message) => appendRoomMessageItem(message, false));
  socket.on('dm:message', ({ peer, thread, message }) => {
    const id = peer.guestId;
    updateDirectThread(peer, thread);
    if (!applyDirectEvent(id, 'new', { message })) return;
    if (getActivePrivateUserId() === id) {
      $('#private-typing-indicator').addClass('hide-element').empty();
      appendDirectMessage(id, message);
      updateDirectAvailability();
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
    if (!directPeers[peerId]?.id || !ready || switching) return;
    if (!privateTypingStopTimeout) socket.volatile.emit('dm:typing', { peerId, isTyping: true });
    clearTimeout(privateTypingStopTimeout);
    privateTypingStopTimeout = setTimeout(() => {
      privateTypingStopTimeout = null;
      socket.volatile.emit('dm:typing', { peerId, isTyping: false });
    }, 1500);
  });

  function resizeComposer(input) {
    if (!input.offsetParent) return;
    input.style.height = '';
    input.style.height = input.scrollHeight + input.offsetHeight - input.clientHeight + 'px';
  }

  function bindComposer(formId, inputId, buttonId, direct) {
    let sending = false;
    const field = document.querySelector(inputId);
    field.addEventListener('input', () => resizeComposer(field));
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      field.form.requestSubmit();
    });
    $(formId).on('submit', async (event) => {
      event.preventDefault();
      const input = $(inputId);
      const text = input.val().trim();
      const peerId = getActivePrivateUserId();
      const peerGuestId = directPeers[peerId]?.guestId;
      if (!ready || switching || sending || !text || (direct && !directPeers[peerId])) return;
      const mode = direct ? 'personal' : 'group';
      const reply = replyTargets[mode];
      const room = currentRoomName;
      sending = true;
      $(buttonId).prop('disabled', true).attr('aria-busy', 'true');
      try {
        await request(direct ? 'dm:send' : 'createMessage', {
          text,
          peerId: direct ? peerId : undefined,
          replyTo: reply?.id,
        });
        if (currentRoomName !== room) return;
        if (replyTargets[mode] === reply) setReplyTarget(mode, null);
        if (direct && getActivePrivateUserId() !== peerId) {
          if (directDrafts.get(peerGuestId)?.trim() === text) directDrafts.delete(peerGuestId);
        } else if (input.val().trim() === text) {
          input.val('');
          resizeComposer(field);
        }
      } catch (error) {
        showError(error.message);
      } finally {
        sending = false;
        $(buttonId).prop('disabled', !ready).removeAttr('aria-busy');
        if (direct) updateDirectAvailability();
      }
    });
  }

  bindComposer('#message-form', '#message-input', '#group-send-btn', false);
  bindComposer('#private-message-form', '#private-message-input', '#private-send-btn', true);

  function bindLocation(selector, direct) {
    $(selector).on('click', function () {
      const peerId = getActivePrivateUserId();
      if (!ready || switching || (direct && !directPeers[peerId])) return;
      if (!navigator.geolocation) return showError('Location sharing is unavailable in this browser.');
      const room = currentRoomName;
      const connection = socket.id;
      const mode = direct ? 'personal' : 'group';
      const reply = replyTargets[mode];
      const button = $(this).prop('disabled', true).attr('aria-busy', 'true');
      const restoreButton = () => {
        button.prop('disabled', false).removeAttr('aria-busy');
        if (direct) updateDirectAvailability();
      };
      navigator.geolocation.getCurrentPosition(async ({ coords }) => {
        if (room !== currentRoomName || connection !== socket.id || switching ||
            (direct && (peerId !== getActivePrivateUserId() || !directPeers[peerId]))) {
          restoreButton();
          showError('The conversation changed before your location could be shared.');
          return;
        }
        const { latitude, longitude } = coords;
        try {
          await request(direct ? 'dm:location' : 'createLocationMessage', { peerId, latitude, longitude, replyTo: reply?.id });
          if (reply && replyTargets[mode] === reply) setReplyTarget(mode, null);
        } catch (error) {
          showError(error.message);
        } finally {
          restoreButton();
        }
      }, (error) => {
        restoreButton();
        showError('Unable to share your location. ' + error.message);
      }, { timeout: 10000, maximumAge: 0 });
    });
  }

  bindLocation('#send-location', false);
  bindLocation('#private-send-location', true);

  function showDirectStatus(status) {
    $('#personal-call-timer, #personal-call-announcement').text(status);
  }

  function showDirectStage(call, status) {
    $('#personal-call-title').text(call.peer.name);
    $('#personal-call-kind').text(call.mode === 'video' ? 'Video call' : 'Audio call');
    $('#personal-call-avatar').text(getInitials(call.peer.name)).attr('style', getAvatarStyle(call.peer.name));
    showDirectStatus(status);
    $('#end-call span').text(call.accepted ? 'End call' : 'Cancel call');
    $('#personal-call-stage').removeClass('hide-element');
    $('#personal-toggle-cam').toggleClass('hide-element', call.mode === 'audio');
    updateDirectAvailability();
    resetMediaButtons('personal');
  }

  async function startDirectCall(mode) {
    const peer = directPeers[getActivePrivateUserId()];
    if (!ready || switching || !peer || directCall) return;
    if (roomCall) return showError('Leave the group call before starting a direct call.');
    const call = { mode, peer, id: null };
    directCall = call;
    sounds.stopMessage();
    sounds.stopPreview();
    showDirectStage(call, 'Calling…');
    try {
      const { id } = await request('call:start', { peerId: peer.guestId, mode });
      call.id = id;
      if (directCall !== call) return send('call:end', { id });
      if (!call.accepted) {
        showDirectStatus('Ringing…');
        sounds.setRinging('outgoing');
      }
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
    updateDirectAvailability();
    $('#incoming-caller-avatar').text(getInitials(caller.name)).attr('style', getAvatarStyle(caller.name));
    $('#incoming-caller-name').text(caller.name);
    $('#incoming-call-label').text(mode === 'video' ? 'Incoming video call' : 'Incoming audio call');
    $('#incoming-call-card').removeClass('hide-element');
    sounds.setRinging('incoming');
  });

  async function connectDirectMedia(call) {
    call.sessionId = 'private:' + call.id;
    const onError = (message) => {
      if (directCall !== call) return;
      showError(message);
      endDirectCall('failed');
    };
    try {
      await startCallMedia(call, {
        scope: 'personal',
        grid: personalGrid,
        isCurrent: () => directCall === call,
        onError,
      });
    } catch (error) {
      onError(error.message);
    }
  }

  function closeDirectCall() {
    if (!directCall) return;
    const call = directCall;
    directCall = null;
    sounds.setRinging(null);
    closeCallMedia(call, personalGrid);
    clearInterval(personalCallTimerTimeout);
    personalCallTimerTimeout = null;
    $('#personal-call-stage, #incoming-call-card').addClass('hide-element');
    resetMediaButtons('personal');
    updateDirectAvailability();
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
    call.accepted = true;
    $('#incoming-call-card').addClass('hide-element');
    sounds.setRinging(null);
    openPersonalChatForPeer(call.peer.guestId);
    showDirectStage(call, 'Connecting…');
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
    showDirectStage(directCall, 'Connecting…');
    connectDirectMedia(directCall);
  });

  socket.on('call:connected', ({ id }) => {
    if (directCall?.id !== id || personalCallTimerTimeout) return;
    const startedAt = Date.now();
    $('#personal-call-announcement').text('Call connected.');
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
  $('#personal-toggle-mic').on('click', function () { toggleTrack($(this), directCall, 'audio'); });
  $('#personal-toggle-cam').on('click', function () { toggleTrack($(this), directCall, 'video'); });

  $('#show-people').on('click', () => setSidebar($('#show-people').attr('aria-expanded') !== 'true'));

  setConnection('Connecting…', false);
  fetch('/api/session', { method: 'POST', signal: AbortSignal.timeout(10000) })
    .then(async (response) => {
      if (!response.ok) throw new Error('Could not start a guest session.');
      ({ guestId } = await response.json());
      socket.connect();
      setupPushNotifications();
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
