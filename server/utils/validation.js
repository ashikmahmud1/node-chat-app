const isRealString = (str, maxLength = 2000) =>
  typeof str === 'string' && str.trim().length > 0 && str.trim().length <= maxLength;

module.exports = { isRealString };
