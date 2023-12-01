const multer = require('multer');
const multerS3 = require('multer-s3');
const AWS = require('aws-sdk');

// Configure AWS SDK
const s3 = new AWS.S3({
    accessKeyId: 'YOUR_ACCESS_KEY_ID',
    secretAccessKey: 'YOUR_SECRET_ACCESS_KEY',
    region: 'YOUR_AWS_REGION', // e.g., 'us-west-1'
});

// Configure multer and multer-s3
const uploadS3 = multer({
    storage: multerS3({
        s3: s3,
        bucket: 'YOUR_S3_BUCKET_NAME',
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            cb(null, Date.now().toString() + '-' + file.originalname);
        },
    }),
});

exports.uploadS3 = uploadS3;
