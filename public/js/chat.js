var socket = io();

function scrollToBottom(id) {
    // Selectors
    var messages = jQuery(id);
    var newMessage = messages.children('li:last-child');
    // Heights
    var clientHeight = messages.prop('clientHeight');
    var scrollTop = messages.prop('scrollTop');
    var scrollHeight = messages.prop('scrollHeight');
    var newMessageHeight = newMessage.innerHeight();
    var lastMessageHeight = newMessage.prev().innerHeight();

    if (clientHeight + scrollTop + newMessageHeight + lastMessageHeight >= scrollHeight) {
        messages.scrollTop(scrollHeight);
    }
}

function update() {
    var $worked = $("#show-time");
    var myTime = $worked.html();
    var ss = myTime.split(":");
    var dt = new Date();
    dt.setHours(0);
    dt.setMinutes(ss[0]);
    dt.setSeconds(ss[1]);

    var dt2 = new Date(dt.valueOf() + 1000);
    var temp = dt2.toTimeString().split(" ");
    var ts = temp[0].split(":");

    $worked.html(ts[1] + ":" + ts[2]);
    setTimeout(update, 1000);
}

function privateScrollToBottom() {
    var modal = document.getElementsByClassName("modal-body")[0];
    modal.scrollTop = modal.scrollHeight;
}

function privateScrollToTop() {
    var modal = document.getElementsByClassName("modal-body")[0];
    modal.scrollTop = 0;
}
//calling variable is useful for identifying the user is a call or not.
var calling = false;
var caller_id = '';
var video_caller_id = '';
//This is user message dictionary where all the message will store.
var user_message_dictionary = {};
//Progress Bar element
var progress_bar = document.getElementById('upload-progress-bar');
var progress_bar_inner = document.getElementById('upload-progress-bar-inner');
//File upload client side start
var uploader = new SocketIOFileClient(socket);
var private_btn_id = document.getElementsByClassName('private-message-send');

//Modal close button
var modal_close_button = document.getElementsByClassName('close');
//private progress bar
var private_progress_bar = document.getElementById('private-upload-progress-bar');
var private_progress_bar_inner = document.getElementById('private-upload-progress-bar-inner');
var message_audio = document.getElementById('message-received');
uploader.on('start', function(fileInfo) {
    if (private_btn_id[0].id == '') {
        console.log('Start uploading', fileInfo);
        progress_bar.classList.remove('progress-hide');
        console.log('this is private_btn_id' + private_btn_id);
    }
    else {
        //disable the modal close button
        modal_close_button[0].setAttribute('disabled', 'disabled')
        //show the private progress bar.
        private_progress_bar.classList.remove('private-progress-hide');
    }
});
uploader.on('stream', function(fileInfo) {
    var percentComplete = fileInfo.sent / fileInfo.size;
    percentComplete = parseInt(percentComplete * 100);
    var width = 'width:' + percentComplete + '%';
    if (private_btn_id[0].id == '') {
        progress_bar_inner.setAttribute('style', width);
        progress_bar_inner.innerHTML = percentComplete + ' %';
    }
    else {
        private_progress_bar_inner.setAttribute('style', width);
        private_progress_bar_inner.innerHTML = percentComplete + ' %'
    }
});
uploader.on('complete', function(fileInfo) {
    if (private_btn_id[0].id == '') {
        console.log('Upload Complete', fileInfo);
        progress_bar.classList.add('progress-hide');
        //emit an event for public chat message
        socket.emit('newFileMessage', fileInfo);
        console.log(private_btn_id);
    }
    else {
        //hide the progress bar
        private_progress_bar.classList.add('private-progress-hide');

        //slice the private button id
        var userid = private_btn_id[0].id.slice(0, -1);
        //upload complete now emit an event for specific user
        socket.emit('newPrivateFileMessage', {
            fileinfo: fileInfo,
            userid: userid
        });
        //enable the modal close button
        modal_close_button[0].removeAttribute('disabled');
    }

});

uploader.on('error', function(err) {
    if (private_btn_id[0].id == '') {
        progress_bar.classList.add('progress-hide');
        console.log('Error!', err);
    }
    else {
        //hide the progress bar
        private_progress_bar.classList.add('private-progress-hide');
        //enable the modal close button
        modal_close_button[0].disable = false;
    }

});
uploader.on('abort', function(fileInfo) {
    if (private_btn_id[0].id == '') {
        progress_bar.classList.add('progress-hide');
        console.log('Error!', err);
    }
    else {
        //hide the progress bar
        private_progress_bar.classList.add('private-progress-hide');
        //enable the modal close button
        modal_close_button[0].disable = false;
    }
});
socket.on('newPrivateFileMessage', function(info) {
    var formattedTime = moment(info.createdAt).format('h:mm a');
    var message_object = {
        from: info.user.name,
        url: info.fileinfo.name,
        createdAt: formattedTime,
        type: 'file'
    }
    add_message(message_object, info.user.id)
    var slice_user_id = '';
    if (private_btn_id[0].id != '') {
        slice_user_id = private_btn_id[0].id.slice(0, -1);
    }
    if (slice_user_id == info.user.id) {

        var template = jQuery('#file-message-template').html();
        var html = Mustache.render(template, {
            from: info.user.name,
            url: info.fileinfo.name,
            createdAt: formattedTime
        });

        jQuery('#private_messages_list').append(html);
        if (!calling) {
            privateScrollToBottom();
        }
        //emit a message to the sender that user got the message.
        socket.emit('privateFileSendSuccessful', info);
        message_audio.src = "/sound/iphone_notification.mp3"
    }
    else {
        //emit an event private location message send successful
        // window not open so add it to the people section
        message_audio.src = "/sound/iphone_notification.mp3"
        socket.emit('privateFileSendSuccessful', info);

        //get element by id message.user.id and get it's sibling and set it innerhtml to number of message
        var userid = document.getElementById(info.user.id);
        //get the sibling element and sets it's attribute display block
        label = userid.nextSibling;
        label.setAttribute('style', 'display:block');
        label.innerHTML = "1"
    }
});
socket.on('privateFileSendSuccessful', function(info) {
    var formattedTime = moment(info.createdAt).format('h:mm a');
    var message_object = {
        from: info.user.name,
        url: info.filename,
        createdAt: formattedTime
    }
    add_message(message_object, info.id);
    var template = jQuery('#file-message-template').html();
    var html = Mustache.render(template, {
        from: info.user.name,
        url: info.filename,
        createdAt: formattedTime
    });

    jQuery('#private_messages_list').append(html);
    if (!calling) {
        privateScrollToBottom();
    }

});
window.addEventListener('load', function() {
    $('#myModal').modal('hide');
});
socket.on('newFileMessage', function(message) {
    var formattedTime = moment(message.createdAt).format('h:mm a');
    var template = jQuery('#file-message-template').html();
    var html = Mustache.render(template, {
        from: message.from,
        url: message.fileurl,
        createdAt: formattedTime
    });

    jQuery('#messages').append(html);
    scrollToBottom('#messages');
    console.log('This is file url ' + message.fileurl);
});

$('#input-file').on('change', function(event) {
    console.log(event.target.files[0].name);
    var fileEl = document.getElementById('input-file');
    uploader.upload(fileEl);

});
//private file upload
$('#private-send-file').on('change', function(event) {
    console.log(event.target.files[0].name);
    var fileEl = document.getElementById('private-send-file');
    uploader.upload(fileEl);
});
//file upload client side end
function upload_file() {
    $('#input-file').click();
}

function upload_private_file() {
    $('#private-send-file').click();
}
socket.on('connect', function() {
    var params = jQuery.deparam(window.location.search);

    socket.emit('join', params, function(err) {
        if (err) {
            alert(err);
            window.location.href = '/';
        }
        else {
            console.log('No error');

        }
    });
});

function private_chat(event) {
    var id = event.target.id;
    //get element by id message.user.id and get it's sibling and set it innerhtml to number of message
    var userid = document.getElementById(event.target.id);
    //get the sibling element and sets it's attribute display block
    
    if(caller_id == id)
    {
        $('#call-receive-section').removeClass('accept-reject-call');
    }
    if(video_caller_id == id){
        $('#video-call-receive-section').removeClass('accept-reject-video-call');
    }
    //check the dictionary with this id if it's not empty or null then add all the message into the tab.
    if (id in user_message_dictionary) {
        //key exsist so add all the message into the tab
        var messages = user_message_dictionary[id];
        for (var i = 0; i < messages.length; i++) {
            //check the message type is it location,file or just message

            //message type is location
            if (messages[i].type == 'location') {
                var template = jQuery('#location-message-template').html();
                var html = Mustache.render(template, {
                    from: messages[i].from,
                    url: messages[i].url,
                    createdAt: messages[i].createdAt
                });
                $('#private_messages_list').append(html);
            }
            //message type is file
            else if (messages[i].type == 'file') {
                var template = jQuery('#file-message-template').html();
                var html = Mustache.render(template, {
                    from: messages[i].from,
                    url: messages[i].url,
                    createdAt: messages[i].createdAt
                });
                jQuery('#private_messages_list').append(html);
            }
            //it's a simple message
            else {
                var template = jQuery('#private-message-template').html();
                var html = Mustache.render(template, {
                    text: messages[i].text,
                    from: messages[i].from,
                    createdAt: messages[i].createdAt
                });
                jQuery('#private_messages_list').append(html);
            }
        }
        console.log(user_message_dictionary);
    }
    label = userid.nextSibling;
    label.setAttribute('style', 'display:none');
    socket.emit('privateMessageWindow', {
        id: event.target.id
    });
}

socket.on('disconnect', function() {
    console.log('Disconnected from server');
});


socket.on('updateUserList', function(users) {
    var userfound = false;
    var ol = jQuery('<ol></ol>');
    users.forEach(function(user) {
        var list = $('<li></li>').text(user.name);
        list.attr('class', 'user-list')
        ol.append(list);
        var button = document.createElement('button');
        button.innerHTML = 'Send Message';
        button.classList.add('btn', 'btn-success', 'private-msg-btn');
        button.setAttribute('id', user.id);
        var label = document.createElement('label');
        label.setAttribute('class', 'new-message');
        list.append(button);
        list.append(label);

        //Check that the user leave without notifying when you two are in calls.
        if (calling) {
            var id = private_btn_id[0].id;
            if (id == user.id) {
                userfound = true;
            }
        }
    });
    if (!userfound && calling) {
        //end the call since user doesn't exist.
        console.log('user not found end the call');
        //end the call
        end_call();
        end_video_call();
        calling = false;
    }
    jQuery('#users').html(ol);
    $('.private-msg-btn').click(private_chat);
});
socket.on('notifyUser', function(data) {
    //Get send private message button
    var private_message_button = document.getElementsByClassName('private-message-send');
    if (private_message_button[0].id == '') {
        var set_id = data.user.id + '0';
        //set the private message button id with the user value.
        private_message_button[0].setAttribute('id', set_id);
        //Get send private location button
        //Get send private file button
        //Set click or change event listener in the buttons

        //Open the user private chat window
        var modalbutton = document.createElement('button');
        modalbutton.setAttribute('type', 'button');
        modalbutton.setAttribute('data-toggle', 'modal');
        modalbutton.setAttribute('data-target', '#myModal');
        modalbutton.setAttribute('class', 'hide-modal-dynamic');
        document.getElementsByTagName('body')[0].appendChild(modalbutton);
        document.getElementsByClassName('modal-title')[0].innerHTML = data.user.name;
        modalbutton.click();
        //end of private chat window
        message_audio.src = "/sound/iphone_notification.mp3"
        socket.emit('private_connection_successful', {
            user: data.user,
            otherUserId: data.otherUser
        });
    }
    else {
        socket.emit('private_connection_successful', {
            user: data.user,
            otherUserId: data.otherUser
        });
    }
    console.log(data.otherUser);
    console.log(data.user);

});
socket.on('openChatWindow', function(user) {
    //Open the user private chat window
    var modalbutton = document.createElement('button');
    modalbutton.setAttribute('type', 'button');
    modalbutton.setAttribute('data-toggle', 'modal');
    modalbutton.setAttribute('data-target', '#myModal');
    modalbutton.setAttribute('class', 'hide-modal-dynamic');
    document.getElementsByTagName('body')[0].appendChild(modalbutton);
    var set_id = user.user.id + '0';
    document.getElementsByClassName('private-message-send')[0].setAttribute('id', set_id);
    document.getElementsByClassName('modal-title')[0].innerHTML = user.user.name;
    modalbutton.click();
    //end of private chat window
    console.log(user.user);
});
document.getElementsByClassName('close')[0].addEventListener('click', function() {
    var private_message_button = document.getElementsByClassName('private-message-send');
    console.log(private_message_button[0].id);
    private_message_button[0].setAttribute('id', '');
    document.getElementById('private_messages_list').innerHTML = '';
    $('#video-call-receive-section').addClass('accept-reject-video-call');
    $('#call-receive-section').addClass('accept-reject-call');
});
$('#myModal').modal({
    backdrop: 'static',
    keyboard: true
})
socket.on('newMessage', function(message) {
    var formattedTime = moment(message.createdAt).format('h:mm a');
    var template = jQuery('#message-template').html();
    var html = Mustache.render(template, {
        text: message.text,
        from: message.from,
        createdAt: formattedTime
    });

    jQuery('#messages').append(html);
    scrollToBottom('#messages');
});
socket.on('newPrivateMessage', function(message) {
    var formattedTime = moment(message.createdAt).format('h:mm a');
    var message_object = {
        text: message.message,
        from: message.user.name,
        createdAt: formattedTime,
        type: 'message'
    }
    add_message(message_object, message.user.id);
    var private_message_button = document.getElementsByClassName('private-message-send')[0].id;
    var slice_id = private_message_button.slice(0, -1);

    if (slice_id == message.user.id) {
        var template = jQuery('#private-message-template').html();
        var html = Mustache.render(template, {
            text: message.message,
            from: message.user.name,
            createdAt: formattedTime
        });
        jQuery('#private_messages_list').append(html);
        if (!calling) {
            privateScrollToBottom();
        }

        message_audio.src = "/sound/iphone_notification.mp3"
        socket.emit('privateMessageSendSuccessful', {
            message: message.message,
            userid: slice_id
        });
    }
    else {
        message_audio.src = "/sound/iphone_notification.mp3"
        //emit an event that private message send failed
        socket.emit('privateMessageSendSuccessful', {
            message: message.message,
            userid: message.user.id
        });
        //get element by id message.user.id and get it's sibling and set it innerhtml to number of message
        var userid = document.getElementById(message.user.id);
        //get the sibling element and sets it's attribute display block
        label = userid.nextSibling;
        label.setAttribute('style', 'display:block');
        label.innerHTML = "1"
    }

});
socket.on('privateMessageSuccessfulAdd', function(message) {
    var formattedTime = moment(message.createdAt).format('h:mm a');
    var message_object = {
        text: message.message,
        from: message.user.name,
        createdAt: formattedTime,
        type: 'message'
    }
    add_message(message_object, message.id);
    var template = jQuery('#private-message-template').html();
    var html = Mustache.render(template, {
        text: message.message,
        from: message.user.name,
        createdAt: formattedTime
    });
    jQuery('#private_messages_list').append(html);
    if (!calling) {
        privateScrollToBottom();
    }

});
socket.on('newLocationMessage', function(message) {
    var formattedTime = moment(message.createdAt).format('h:mm a');
    var template = jQuery('#location-message-template').html();
    var html = Mustache.render(template, {
        from: message.from,
        url: message.url,
        createdAt: formattedTime
    });

    jQuery('#messages').append(html);
    scrollToBottom('#messages');
});


$('#private-message-form').on('submit', function(e) {
    e.preventDefault();
    var private_messageTextbox = $('[name=private-message]');
    var private_userid = document.getElementsByClassName('private-message-send')[0].id;
    var slice_id = private_userid.slice(0, -1);
    console.log(private_messageTextbox.val());
    socket.emit('createPrivateMessage', {
        message: private_messageTextbox.val(),
        userid: slice_id
    });
    private_messageTextbox.val('');
});


jQuery('#message-form').on('submit', function(e) {
    e.preventDefault();

    var messageTextbox = jQuery('[name=message]');

    socket.emit('createMessage', {
        text: messageTextbox.val()
    }, function() {
        messageTextbox.val('')
    });
});

var locationButton = jQuery('#send-location');
locationButton.on('click', function() {
    if (!navigator.geolocation) {
        return alert('Geolocation not supported by your browser.');
    }

    locationButton.attr('disabled', 'disabled').text('Sending location...');

    navigator.geolocation.getCurrentPosition(function(position) {
        locationButton.removeAttr('disabled').text('Send location');
        socket.emit('createLocationMessage', {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
        });
    }, function() {
        locationButton.removeAttr('disabled').text('Send location');
        alert('Unable to fetch location.');
    });
});
var privatelocation = $('#private-send-location');
privatelocation.on('click', function() {
    if (!navigator.geolocation) {
        return alert('Geolocation not supported by your browser.');
    }
    var userid = private_btn_id[0].id.slice(0, -1);
    privatelocation.attr('disabled', 'disabled').text('Sending location...');

    navigator.geolocation.getCurrentPosition(function(position) {
        privatelocation.removeAttr('disabled').text('Send location');
        socket.emit('createPrivateLocationMessage', {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            userid: userid
        });
    }, function() {
        privatelocation.removeAttr('disabled').text('Send location');
        alert('Unable to fetch location.');
    });
});
socket.on('newPrivateLocationMessage', function(message) {
    var formattedTime = moment(message.location.createdAt).format('h:mm a');
    //create an object of message
    var message_object = {
        from: message.location.from,
        url: message.location.url,
        createdAt: formattedTime,
        type: 'location'
    }
    //add the message to the dictionary
    add_message(message_object, message.user.id);
    var slice_user_id = '';
    if (private_btn_id[0].id != '') {
        slice_user_id = private_btn_id[0].id.slice(0, -1);
    }
    if (slice_user_id == message.user.id) {
        var template = jQuery('#location-message-template').html();
        var html = Mustache.render(template, {
            from: message.location.from,
            url: message.location.url,
            createdAt: formattedTime
        });
        jQuery('#private_messages_list').append(html);
        if (!calling) {
            privateScrollToBottom();
        }

        message_audio.src = "/sound/iphone_notification.mp3"
        //emit an event new private message location send successful
        socket.emit('locationMessageSuccessful', message);
    }
    else {
        //emit an event private location message send successful
        // window not open so add it to the people section
        message_audio.src = "/sound/iphone_notification.mp3"
        socket.emit('locationMessageSuccessful', message);
        //get element by id message.user.id and get it's sibling and set it innerhtml to number of message
        var userid = document.getElementById(message.user.id);
        //get the sibling element and sets it's attribute display block
        label = userid.nextSibling;
        label.setAttribute('style', 'display:block');
        label.innerHTML = "1"
    }
});
socket.on('locationMessageSuccessful', function(message) {
    var formattedTime = moment(message.message.location.createdAt).format('h:mm a');
    //create an object of message
    var message_object = {
        from: message.message.location.from,
        url: message.message.location.url,
        createdAt: formattedTime,
        type: 'location'
    }
    add_message(message_object, message.id);
    var template = jQuery('#location-message-template').html();
    var html = Mustache.render(template, {
        from: message.message.location.from,
        url: message.message.location.url,
        createdAt: formattedTime
    });
    jQuery('#private_messages_list').append(html);
    if (!calling) {
        privateScrollToBottom();
    }

});

var calling_audio = document.getElementById("audioCalling");

socket.on('onAudioCall', function(arrayBuffer) {

    var blob = new Blob([arrayBuffer], { 'type': 'audio/ogg; codecs=opus' });
    calling_audio.src = window.URL.createObjectURL(blob);

});

$("#accept-call").on('click', function() {
    var userid = private_btn_id[0].id.slice(0, -1);
    //let know the user that the call is received.
    socket.emit('callReceived', userid);
    $('#call-receive-section').addClass('accept-reject-call');
    //show end-call section
    $('#call-section').removeClass('end-call');

    //all the button is disabled.
    $('#audio-call').attr('disabled', true);
    $('#video-call').attr('disabled', true);
    modal_close_button[0].setAttribute('disabled', 'disabled');

    //hide the alert section
    $('#alert-box').addClass('alert-hide');
    //also start sending voice
    document.getElementById('audio-call-start').click();
    calling = true;
    //show the timer
    $('#show-time').removeClass('hide-time');
    document.getElementById('show-time').innerHTML = "00:00";
    $('#show-call-text').addClass('hide-time');
    setTimeout(update, 1000);

});


//Reject call section. if the user click on the reject button
$('#reject-call').on('click', function(event) {
    var userid = private_btn_id[0].id.slice(0, -1);
    reject_call(userid);
});


//hide the call receive section
function hide_receive_section(userid) {
    setTimeout(function() {
        if (!calling) {
            reject_call(userid);
        }
    }, 18000);
}

function reject_call(userid) {
    socket.emit('callNotReceived', userid);
    //let know the other user that call is not received.
    $('#call-receive-section').addClass('accept-reject-call');
    $('#audio-call').attr('disabled', false);
    $('#video-call').attr('disabled', false);
    modal_close_button[0].removeAttribute('disabled');
    //hide the alert section
    $('#alert-box').addClass('alert-hide');
    caller_id = '';
}

//audio call button click. Emit an event calling...
$('#audio-call').on('click', function(event) {
    var userid = private_btn_id[0].id.slice(0, -1);
    console.log(userid);
    socket.emit('initializeAudioCall', userid);
    //appear the calling section
    $('#call-section').removeClass('end-call');
    //disable the audio call and video call button
    $('#audio-call').attr('disabled', true);
    $('#video-call').attr('disabled', true);
    modal_close_button[0].setAttribute('disabled', 'disabled');
    calling = true;
    privateScrollToTop();
});

socket.on('incomingCall', function(user) {
    if (!calling) {
        var id = private_btn_id[0].id.slice(0, -1);
        if (id != user.id) {
            //show the alert box.
            $('#alert-box').removeClass('alert-hide');
            document.getElementsByClassName('alert-text')[0].innerHTML = user.name + " Calling......";
            caller_id = user.id;
        }
        else
        {
            //appear the call receive section
            $('#call-receive-section').removeClass('accept-reject-call');
            $('#audio-call').attr('disabled', true);
            $('#video-call').attr('disabled', true);
            document.getElementById('audio-calling-text').innerHTML = user.name + " Calling......";
            modal_close_button[0].setAttribute('disabled', 'disabled');
        }
        

        hide_receive_section(user.id);
        privateScrollToTop();
        
    }
    else {
        //let know the caller that the user is busy.
        socket.emit('userBusy', user.id);
    }

});
//if call recived then start streaming and set the calling variable to true
//end call set the calling variable to false
socket.on('userBusy',function() {
    //hide the video calling section.
    end_call();
    alert('User busy. Try again after sometimes.');
})

var audio_message;
$('#audio-call-start').on('click', function() {
    var constraints = {
        audio: true
    };
    var recordRTC = null;
    var userid = private_btn_id[0].id.slice(0, -1);
    console.log(userid);
    navigator.mediaDevices.getUserMedia(constraints).then(function(mediaStream) {
        var mediaRecorder = new MediaRecorder(mediaStream);
        mediaRecorder.onstart = function(e) {
            this.chunks = [];
        };
        mediaRecorder.ondataavailable = function(e) {
            this.chunks.push(e.data);
            console.log("still it's streaming")
        };
        mediaRecorder.onstop = function(e) {
            var blob = new Blob(this.chunks, { 'type': 'audio/ogg; codecs=opus' });
            socket.emit('audioCall', { blob: blob, userid: userid });
        };

        // Start recording
        mediaRecorder.start();
        // Stop recording after .5 seconds and broadcast it to server
        audio_message = setInterval(function() {
            mediaRecorder.stop()
            mediaRecorder.start()
        }, 1000);
    });
});


//end call button clicked
$('#end-call').on('click', function(event) {

    //emit an event to the other user that call has been ended.
    //get userid
    var userid = private_btn_id[0].id.slice(0, -1);
    end_call();
    socket.emit('callEnded', userid);
    $('#show-time').addClass('hide-time');
    $('#show-call-text').removeClass('hide-time');
    
    //clear the call screen.
});

socket.on('callEnded', function(user) {
    end_call();
    //clear the call screen
    console.log('Call Ended');
    $('#show-time').addClass('hide-time');
    $('#show-call-text').removeClass('hide-time');
});

function end_call() {
    //stop broadcasting the audio
    clearInterval(audio_message);
    //enable all the audio call and video call and close button
    $('#audio-call').attr('disabled', false);
    $('#video-call').attr('disabled', false);
    modal_close_button[0].removeAttribute('disabled');
    $('#call-section').addClass('end-call');
    calling = false;
    caller_id = '';
}
socket.on('callNotReceived', function() {
    //hide the call section
    $('#call-section').addClass('end-call');
    //enable all the audio call and video call and close button
    $('#audio-call').attr('disabled', false);
    $('#video-call').attr('disabled', false);
    modal_close_button[0].removeAttribute('disabled');
    calling = false;
    caller_id = '';
});
socket.on('notifyCallReceived', function() {
    //now you can start streaming data
    document.getElementById('audio-call-start').click();
    
    //show the timer
    $('#show-time').removeClass('hide-time');
    document.getElementById('show-time').innerHTML = "00:00";
    $('#show-call-text').addClass('hide-time');
    setTimeout(update, 1000);
    //
})
//show people in mobile device
$('#show-people').on('click', function(event) {
    var chat_sidebar = document.getElementById('chat__sidebar');
    var show_people = document.getElementById('show-people');
    var change_arrow = document.getElementById('change-arrow');
    if ($("#chat__sidebar").hasClass("hide-show-people")) {
        // Do something if class exists
        chat_sidebar.classList.remove('hide-show-people');
        show_people.classList.remove('change-button-position');
        change_arrow.classList.add('fa-arrow-right');
        change_arrow.classList.remove('fa-arrow-left');
    }
    else {
        // Do something if class does not exist
        chat_sidebar.classList.add('hide-show-people');
        show_people.classList.add('change-button-position');
        change_arrow.classList.remove('fa-arrow-right');
        change_arrow.classList.add('fa-arrow-left');

    }
});




//Video Call Section

//two way handshaking is needed. Two way hand shaking is needed. it means the call will send to 
//the user and if he click on accept button then start streaming otherwise end the call after 18s
//audio call button click. Emit an event calling...
$('#video-call').on('click', function(event) {
    var userid = private_btn_id[0].id.slice(0, -1);
    socket.emit('initializeVideoCall', userid);
    //appear the video calling section
    $('#video-call-section').removeClass('end-video-call');
    //disable the audio call and video call button
    $('#audio-call').attr('disabled', true);
    $('#video-call').attr('disabled', true);
    modal_close_button[0].setAttribute('disabled', 'disabled');
    calling = true;
    privateScrollToTop();
});

//End Video Call Section

//Incoming video section start section
socket.on('incomingVideoCall', function(user) {
    if (!calling) {
        var id = private_btn_id[0].id.slice(0, -1);
        if (id != user.id) {
            //show the alert box.
            $('#alert-box').removeClass('alert-hide');
            document.getElementsByClassName('alert-text')[0].innerHTML = user.name + " Video Calling......"
            video_caller_id = user.id
        }
        else{
            document.getElementById('video-calling-text').innerHTML = user.name + " Video Calling......";
            //appear the call receive section
            $('#video-call-receive-section').removeClass('accept-reject-video-call');
            $('#audio-call').attr('disabled', true);
            $('#video-call').attr('disabled', true);
            modal_close_button[0].setAttribute('disabled', 'disabled');
        }
        hide_video_section(user.id);
        privateScrollToTop();
    }
    else {
        //let know the caller that the user is busy.
        socket.emit('userVideoBusy',user.id);
    }

});
//End Incoming video section start section
socket.on('userVideoBusy',function() {
    //hide the video calling section.
    end_video_call();
    alert('User busy. Try again after sometimes');
})

//If user accept that call the below code will be execute
$("#accept-video-call").on('click', function() {
    var userid = private_btn_id[0].id.slice(0, -1);
    //let know the user that the call is received.
    socket.emit('videoCallReceived', userid);
    $('#video-call-receive-section').addClass('accept-reject-video-call');
    //show end-call section
    $('#video-call-section').removeClass('end-video-call');

    //all the button is disabled.
    $('#audio-call').attr('disabled', true);
    $('#video-call').attr('disabled', true);
    modal_close_button[0].setAttribute('disabled', 'disabled');

    //hide the alert section
    $('#alert-box').addClass('alert-hide');
    //also start sending voice
    document.getElementById('video-call-start').click();
    calling = true;
    
    //show the video
    $('#other-video').removeClass('other-video');
    //show the timer.

});
//End of accept video call

//If video call accepted the the below code will be executed
socket.on('notifyVideoCallReceived', function() {
    //now you can start streaming data
    document.getElementById('video-call-start').click();
    
    
    //show the video section
    $('#other-video').removeClass('other-video');
})
//Start video transmitting
$('#video-call-start').on('click', function() {
    var constraints = {
        audio: true,
        video: true
    };
    var recordRTC = null;
    var userid = private_btn_id[0].id.slice(0, -1);
    console.log(userid);
    navigator.mediaDevices.getUserMedia(constraints).then(function(mediaStream) {
        var mediaRecorder = new MediaRecorder(mediaStream);
        mediaRecorder.onstart = function(e) {
            this.chunks = [];
        };
        mediaRecorder.ondataavailable = function(e) {
            this.chunks.push(e.data);
            console.log("still it's streaming")
        };
        mediaRecorder.onstop = function(e) {
            var blob = new Blob(this.chunks, { 'type': 'video/webm; codecs=vp9' });
            //show the video in the self video section
            socket.emit('videoCall', { blob: blob, userid: userid });
        };

        // Start recording
        mediaRecorder.start();
        // Stop recording after .5 seconds and broadcast it to server
        audio_message = setInterval(function() {
            mediaRecorder.stop()
            mediaRecorder.start()
        }, 1000);
    });
});

//
socket.on('onVideoCall', function(arrayBuffer) {

    var blob = new Blob([arrayBuffer], { 'type': 'video/webm; codecs=vp9' });
    document.getElementById('other-video').src = window.URL.createObjectURL(blob);
});
//if user doesn't accept the call and if the user click on the reject button then the below code will be executed
//Reject call section. if the user click on the reject button
$('#reject-video-call').on('click', function(event) {
    var userid = private_btn_id[0].id.slice(0, -1);
    reject_video_call(userid);
});

//hide the call receive section
function hide_video_section(userid) {
    setTimeout(function() {
        if (!calling) {
            reject_video_call(userid);
        }
    }, 18000);
}

function reject_video_call(userid) {
    //server will here to this videoCallNotReceived event
    socket.emit('videoCallNotReceived', userid);
    //let know the other user that call is not received.
    $('#video-call-receive-section').addClass('accept-reject-video-call');
    $('#audio-call').attr('disabled', false);
    $('#video-call').attr('disabled', false);
    modal_close_button[0].removeAttribute('disabled');
    //hide the alert section
    $('#alert-box').addClass('alert-hide');
    video_caller_id = '';
}

socket.on('videoCallNotReceived', function(info) {
    //hide the call section
    $('#video-call-section').addClass('end-video-call');
    //enable all the audio call and video call and close button
    $('#audio-call').attr('disabled', false);
    $('#video-call').attr('disabled', false);
    modal_close_button[0].removeAttribute('disabled');
    calling = false;
})
//End of reject call

//Video Call End
//end call button clicked
function end_video_call() {
    //stop broadcasting the audio
    clearInterval(audio_message);
    //enable all the audio call and video call and close button
    $('#audio-call').attr('disabled', false);
    $('#video-call').attr('disabled', false);
    modal_close_button[0].removeAttribute('disabled');
    $('#video-call-section').addClass('end-video-call');
    calling = false;
    video_caller_id = '';
}
$('#end-video-call').on('click', function(event) {

    //emit an event to the other user that call has been ended.
    //get userid
    var userid = private_btn_id[0].id.slice(0, -1);
    end_video_call();
    socket.emit('videoCallEnded', userid);

    //clear the call screen.
    //hide the video section
    $('#other-video').addClass('other-video');
});

socket.on('videoCallEnded', function(user) {
    end_video_call();
    //clear the call screen
    console.log('Call Ended');
    //hide the video section
    $('#other-video').addClass('other-video');
});
//Video Call End
//function add message to the dictionary
function add_message(message, id) {

    //check that key already exist or not in the dictionary

    if (id in user_message_dictionary) {
        //key exsist so push that object to the dictionary array
        user_message_dictionary[id].push(message);
        console.log(user_message_dictionary);
    }
    else {
        //key doesn't exsist so intialize the dictionary with that key with an array.
        user_message_dictionary[id] = [];
        user_message_dictionary[id].push(message);
        console.log(user_message_dictionary);

    }
}
