const express = require('express');
const fileRoutes = require('./file.routes');

const router = express.Router();

router.use('/', fileRoutes);

module.exports = router;
