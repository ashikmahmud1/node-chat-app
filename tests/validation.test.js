const { expect } = require('expect');
const { isRealString } = require('../server/utils/validation');

describe('Validation Utilities', () => {
  describe('isRealString', () => {
    it('should reject non-string values', () => {
      expect(isRealString(98)).toBe(false);
      expect(isRealString(null)).toBe(false);
      expect(isRealString(undefined)).toBe(false);
      expect(isRealString({})).toBe(false);
    });

    it('should reject strings with only spaces', () => {
      expect(isRealString('    ')).toBe(false);
      expect(isRealString('')).toBe(false);
    });

    it('should allow strings with non-space characters', () => {
      expect(isRealString('  Ashik  ')).toBe(true);
      expect(isRealString('D')).toBe(true);
    });
  });
});
