const express = require('express');
const fileRoutes = require('./file.routes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.use('/', fileRoutes);

module.exports = router;
