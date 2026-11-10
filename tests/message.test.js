const { expect } = require('expect');
const { generateMessage, generateLocationMessage, generateFiles } = require('../server/utils/message');

describe('Message Utilities', () => {
  describe('generateMessage', () => {
    it('should generate a valid message object', () => {
      const from = 'Jen';
      const text = 'Some message';
      const message = generateMessage(from, text);

      expect(typeof message.createdAt).toBe('number');
      expect(message).toMatchObject({ from, text });
    });
  });

  describe('generateLocationMessage', () => {
    it('should generate a valid location object', () => {
      const from = 'Deb';
      const latitude = 15;
      const longitude = 19;
      const url = 'https://www.google.com/maps?q=15,19';
      const message = generateLocationMessage(from, latitude, longitude);

      expect(typeof message.createdAt).toBe('number');
      expect(message).toMatchObject({ from, url });
    });
  });

  describe('generateFiles', () => {
    it('should generate a valid file message object with consistent URL properties', () => {
      const from = 'Ashik';
      const filename = '1700000000-sample.pdf';
      const fileMessage = generateFiles(from, filename);

      expect(typeof fileMessage.createdAt).toBe('number');
      expect(fileMessage).toMatchObject({
        from,
        fileUrl: filename,
        fileurl: filename,
        url: filename,
      });
    });
  });
});
