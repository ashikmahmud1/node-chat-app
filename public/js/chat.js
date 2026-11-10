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

// Dictionary storing private message history per user ID
var user_message_dictionary = {};
// Persistent unread badge counter per user ID (survives updateUserList re-renders)
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

function update() {
  if (!calling) return;
  var $worked = $('#show-time');
  var myTime = $worked.html() || '00:00';
  var ss = myTime.split(':');
  var dt = new Date();
  dt.setHours(0);
  dt.setMinutes(parseInt(ss[0], 10) || 0);
  dt.setSeconds(parseInt(ss[1], 10) || 0);

  var dt2 = new Date(dt.valueOf() + 1000);
  var temp = dt2.toTimeString().split(' ');
  var ts = temp[0].split(':');

  $worked.html(ts[1] + ':' + ts[2]);
  callTimerTimeout = setTimeout(update, 1000);
}

function stopCallTimer() {
  if (callTimerTimeout) {
    clearTimeout(callTimerTimeout);
    callTimerTimeout = null;
  }
}

function stopMediaStream() {
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
}

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

// Allow clicking the incoming call alert banner to switch directly to the caller's modal
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
    document.getElementById('video-calling-text').innerHTML = callerUser.name + ' Video Calling......';
    $('#video-call-receive-section').removeClass('accept-reject-video-call');
    $('#audio-call').attr('disabled', true);
    $('#video-call').attr('disabled', true);
    modal_close_button[0].setAttribute('disabled', 'disabled');
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
  var formattedTime = moment(message.createdAt).format('h:mm a');
  var fileUrl = message.fileUrl || message.fileurl || message.url;
  var template = jQuery('#file-message-template').html();
  var html = Mustache.render(template, {
    from: message.from,
    url: fileUrl,
    createdAt: formattedTime,
  });

  jQuery('#messages').append(html);
  scrollToBottom('#messages');
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
    error: function (err) {
      console.error('Error uploading file:', err);
      if (modal_close_button[0]) {
        modal_close_button[0].removeAttribute('disabled');
      }
      alert('Failed to upload file. Please try again.');
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

  socket.emit('join', params, function (err) {
    if (err) {
      alert(err);
      window.location.href = '/';
    }
  });
});

function private_chat(event) {
  var id = event.target.id;
  if (!id || id === socket.id) return;

  var targetUser = room_users_map[id];
  var targetName = targetUser ? targetUser.name : 'Private Chat';

  // Immediately open modal for the selected user
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

  users.forEach(function (user) {
    room_users_map[user.id] = user;
    var isSelf = user.id === socket.id;
    var displayName = isSelf ? user.name + ' (You)' : user.name;
    var list = $('<li></li>').text(displayName);
    list.attr('class', 'user-list');
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

  // Clean up pending call alerts if the caller disconnected
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
  $('#video-call-receive-section').addClass('accept-reject-video-call');
  $('#call-receive-section').addClass('accept-reject-call');
});

$('#myModal').modal({
  backdrop: 'static',
  keyboard: true,
  show: false,
});

socket.on('newMessage', function (message) {
  var formattedTime = moment(message.createdAt).format('h:mm a');
  var template = jQuery('#message-template').html();
  var html = Mustache.render(template, {
    text: message.text,
    from: message.from,
    createdAt: formattedTime,
  });

  jQuery('#messages').append(html);
  scrollToBottom('#messages');
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
  var formattedTime = moment(message.createdAt).format('h:mm a');
  var template = jQuery('#location-message-template').html();
  var html = Mustache.render(template, {
    from: message.from,
    url: message.url,
    createdAt: formattedTime,
  });

  jQuery('#messages').append(html);
  scrollToBottom('#messages');
});

$('#private-message-form').on('submit', function (e) {
  e.preventDefault();
  var private_messageTextbox = $('[name=private-message]');
  var text = private_messageTextbox.val();
  var slice_id = getActivePrivateUserId();

  if (!text || !text.trim() || !slice_id) return;

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
      locationButton.removeAttr('disabled').text('Send location');
      socket.emit('createLocationMessage', {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });
    },
    function () {
      locationButton.removeAttr('disabled').text('Send location');
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
      privatelocation.removeAttr('disabled').text('Send location');
      socket.emit('createPrivateLocationMessage', {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        userid: userid,
      });
    },
    function () {
      privatelocation.removeAttr('disabled').text('Send location');
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
      // Automatically open caller's modal so user can immediately Accept or Reject
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
  alert('User busy. Try again after some time.');
});

$('#audio-call-start').on('click', function () {
  var constraints = { audio: true };
  var userid = getActivePrivateUserId() || caller_id;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then(function (mediaStream) {
      activeMediaStream = mediaStream;
      var mediaRecorder = new MediaRecorder(mediaStream);
      activeMediaRecorder = mediaRecorder;

      mediaRecorder.onstart = function () {
        this.chunks = [];
      };
      mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };
      mediaRecorder.onstop = function () {
        if (!calling) return;
        var blob = new Blob(this.chunks, { type: 'audio/ogg; codecs=opus' });
        socket.emit('audioCall', { blob: blob, userid: userid });
      };

      mediaRecorder.start();
      audio_message = setInterval(function () {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
          mediaRecorder.start();
        }
      }, 1000);
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
    change_arrow.classList.add('fa-arrow-right');
    change_arrow.classList.remove('fa-arrow-left');
  } else {
    chat_sidebar.classList.add('hide-show-people');
    show_people.classList.add('change-button-position');
    change_arrow.classList.remove('fa-arrow-right');
    change_arrow.classList.add('fa-arrow-left');
  }
});

// Video Call Section
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
      // Automatically open caller's modal so user can immediately Accept or Reject
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
  alert('User busy. Try again after some time.');
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

      var mediaRecorder = new MediaRecorder(mediaStream);
      activeMediaRecorder = mediaRecorder;

      mediaRecorder.onstart = function () {
        this.chunks = [];
      };
      mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };
      mediaRecorder.onstop = function () {
        if (!calling) return;
        var blob = new Blob(this.chunks, { type: 'video/webm; codecs=vp9' });
        socket.emit('videoCall', { blob: blob, userid: userid });
      };

      mediaRecorder.start();
      audio_message = setInterval(function () {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
          mediaRecorder.start();
        }
      }, 1000);
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
