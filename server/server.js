const path=require('path');
const express=require('express');

const publicPath=path.join(__dirname,'../public');
const port=process.env.port || 3000;
var app=express();

app.set('port', port);
app.use(express.static(publicPath));

app.listen(port, function () {
    console.log('Server started on port ' + app.get('port'));
});