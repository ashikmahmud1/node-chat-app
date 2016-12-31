const path=require('path');
const http=require('http');
const express=require('express');
const socketIO=require('socket.io');
const port=process.env.PORT || 3000;

const publicPath=path.join(__dirname,'../public');
var app=express();
var server=http.createServer(app);
var io=socketIO(server);

app.set('port', port);
app.use(express.static(publicPath));

io.on('connection',function(socket){
    console.log('New User Connected');
    socket.on('disconnect',function () {
        console.log('User Was Disconnected');
    })
});

server.listen(port, function () {
    console.log('Server started on port ' + port);
});