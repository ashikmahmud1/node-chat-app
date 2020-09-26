const path = require('path');
const http = require('http');
const express = require('express');
const socketIO = require('socket.io');
const SocketIOFile = require('socket.io-file');

const {generateMessage, generateLocationMessage,generateFiles} = require('./utils/message');
const {isRealString} = require('./utils/validation');
const {Users} = require('./utils/users');

const publicPath = path.join(__dirname, '../public');
const port = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const users = new Users();

app.use(express.static(publicPath));

app.get('/:file(*)', function(req, res, next){ // this routes all types of file

    let path=require('path');

    const file = req.params.file;

    path = path.resolve(".")+'/'+file;
    res.download(path); // magic of download fuction

});
io.on('connection', (socket) => {
    console.log('New user connected');

    socket.on('join', (params, callback) => {
        if (!isRealString(params.name) || !isRealString(params.room)) {
            return callback('Name and room name are required.');
        }

        socket.join(params.room);
        users.removeUser(socket.id);
        users.addUser(socket.id, params.name, params.room);

        io.to(params.room).emit('updateUserList', users.getUserList(params.room));
        socket.emit('newMessage', generateMessage('Admin', 'Welcome to the chat app'));
        socket.broadcast.to(params.room).emit('newMessage', generateMessage('Admin', `${params.name} has joined.`));
        callback();
    });

    socket.on('createMessage', (message, callback) => {
        const user = users.getUser(socket.id);
        console.log(user);
        console.log(socket.id);

        if (user && isRealString(message.text)) {
            io.to(user.room).emit('newMessage', generateMessage(user.name, message.text));
        }

        callback();
    });
    socket.on('createPrivateMessage', (message) => {
       socket.broadcast.to(message.userid).emit('newPrivateMessage',{
           message:message.message,
           user:users.getUser(socket.id)
       });
       console.log(message.message);
    });
    socket.on('privateMessageWindow', (userid) => {
        const user = users.getUser(socket.id);
        console.log(userid);
        socket.broadcast.to(userid.id).emit('notifyUser',{
            user:users.getUser(socket.id),
            otherUser:userid.id
        });
    });
    socket.on('private_connection_successful',(user) => {
        console.log(user.otherUserId);
        socket.broadcast.to(user.user.id).emit('openChatWindow',{
            user:users.getUser(user.otherUserId)
        });
    });
    socket.on('privateMessageSendSuccessful',function (message) {
        console.log(users.getUser(socket.id));
        const message_object ={
            message:message.message,
            user:users.getUser(message.userid),
            id:socket.id
        }
        socket.broadcast.to(message.userid).emit('privateMessageSuccessfulAdd',message_object);
    });
    socket.on('createLocationMessage', (coords) => {
        const user = users.getUser(socket.id);

        if (user) {
            io.to(user.room).emit('newLocationMessage', generateLocationMessage(user.name, coords.latitude, coords.longitude));
        }
    });
    //This part is for uploading file
    const uploader = new SocketIOFile(socket, {
        // uploadDir: {			// multiple directories
        // 	music: 'data/music',
        // 	document: 'data/document'
        // },
        uploadDir: 'data',							// simple directory,		// chrome and some of browsers checking mp3 as 'audio/mp3', not 'audio/mpeg'
        maxFileSize: 4194304, 						// 4 MB. default is undefined(no limit)
        chunkSize: 10240,							// default is 10240(1KB)
        transmissionDelay: 0,						// delay of each transmission, higher value saves more cpu resources, lower upload speed. default is 0(no delay)
        overwrite: true 							// overwrite file if exists, default is true.
    });
    uploader.on('start', (fileInfo) => {
        console.log('Start uploading');
        console.log(fileInfo);
    });
    uploader.on('stream', (fileInfo) => {
        console.log(`${fileInfo.wrote} / ${fileInfo.size} byte(s)`);
    });
    uploader.on('complete', (fileInfo) => {
        console.log('Upload Complete.');
        console.log(fileInfo);
    });
    uploader.on('error', (err) => {
        console.log('Error!', err);
    });
    uploader.on('abort', (fileInfo) => {
        console.log('Aborted: ', fileInfo);
    });
    socket.on('newFileMessage',(fileInfo) =>{
        const user = users.getUser(socket.id);
        console.log(user);
        if (user) {
            io.to(user.room).emit('newFileMessage', generateFiles(user.name, fileInfo.name));
        }
    });
    socket.on('newPrivateFileMessage',(info) =>{
       const user = users.getUser(socket.id);
       console.log(user);
       console.log(info.fileinfo);
       socket.broadcast.to(info.userid).emit('newPrivateFileMessage',{
           user:user,
           fileinfo:info.fileinfo
       });
    });
    socket.on('privateFileSendSuccessful', (info) =>{
        const user = users.getUser(info.user.id);
        socket.broadcast.to(info.user.id).emit('privateFileSendSuccessful',{
           filename:info.fileinfo.name,
           user:user,
           id:socket.id
        });
    });
    socket.on('createPrivateLocationMessage',(coords) =>{
        const user = users.getUser(socket.id);
        const location = generateLocationMessage(user.name,coords.latitude,coords.longitude);
        socket.broadcast.to(coords.userid).emit('newPrivateLocationMessage', {
            location:location,
            user:user
        });
    });
    socket.on('locationMessageSuccessful',(message) =>{
        const newMessage ={
            message:message,
            id:socket.id
        }
        socket.broadcast.to(message.user.id).emit('locationMessageSuccessful',newMessage);
    });
    socket.on('initializeAudioCall', (userid) =>{
        const user = users.getUser(socket.id);
       socket.broadcast.to(userid).emit('incomingCall',user); 
       console.log(userid);
    });
    socket.on('initializeVideoCall', (userid) =>{
       const user = users.getUser(socket.id);
       socket.broadcast.to(userid).emit('incomingVideoCall',user);
    });
    socket.on('callReceived', (userid) =>{
       socket.broadcast.to(userid).emit('notifyCallReceived'); 
    });
    socket.on('videoCallReceived', (userid) =>{
        socket.broadcast.to(userid).emit('notifyVideoCallReceived');
    });
    socket.on('audioCall', (stream) =>{
        socket.broadcast.to(stream.userid).emit('onAudioCall',stream.blob);
    });
    socket.on('videoCall', (stream) =>{
        socket.broadcast.to(stream.userid).emit('onVideoCall',stream.blob);
    })
    socket.on('callEnded', (userid) =>{
       const user = users.getUser(socket.id);
       socket.broadcast.to(userid).emit('callEnded',user);
       console.log(userid);
    });
    socket.on('videoCallEnded', (userid) =>{
       const user = users.getUser(socket.id);
       socket.broadcast.to(userid).emit('videoCallEnded',user);
       console.log(userid);
    });
    socket.on('userBusy', (userid) =>{
        socket.broadcast.to(userid).emit('userBusy');
    })
    socket.on('userVideoBusy', (userid) =>{
        socket.broadcast.to(userid).emit('userVideoBusy');
    });
    socket.on('callNotReceived', (userid) =>{
        socket.broadcast.to(userid).emit('callNotReceived');
    });
    socket.on('videoCallNotReceived', (userid) =>{
        socket.broadcast.to(userid).emit('videoCallNotReceived');
    })
    //end file uploading part
    socket.on('disconnect', () => {
        const user = users.removeUser(socket.id);

        if (user) {
            io.to(user.room).emit('updateUserList', users.getUserList(user.room));
            io.to(user.room).emit('newMessage', generateMessage('Admin', `${user.name} has left.`));
        }
    });
});

server.listen(port, () => {
    console.log(`Server is up on ${port}`);
});
