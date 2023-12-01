const multer = require('multer');
const path = require('path');

// Configure the storage for uploaded files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Set the destination folder for uploaded files
        cb(null, path.join(__dirname, '../../data/'))
    },
    filename: (req, file, cb) => {
        // Set the filename for the uploaded file
        cb(null, Date.now() + '-' + file.originalname);
    },
});

exports.upload = multer({ storage });
