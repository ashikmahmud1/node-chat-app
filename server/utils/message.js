const { randomUUID } = require('crypto');
const moment = require('moment');

const generateMessage = (from, text) => ({
  id: randomUUID(),
  type: 'text',
  from,
  text,
  createdAt: moment().valueOf(),
});

const generateLocationMessage = (from, latitude, longitude) => ({
  id: randomUUID(),
  type: 'location',
  from,
  url: `https://www.google.com/maps?q=${latitude},${longitude}`,
  createdAt: moment().valueOf(),
});

const generateFiles = (from, fileUrl) => ({
  id: randomUUID(),
  type: 'file',
  from,
  fileUrl,
  fileurl: fileUrl,
  url: fileUrl,
  createdAt: moment().valueOf(),
});

module.exports = {
  generateMessage,
  generateLocationMessage,
  generateFiles,
};
