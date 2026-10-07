import { sanitizeOtp } from '../OtpField';

describe('OTP input sanitising', () => {
  it.each([
    ['246810', '246810'],
    ['246 810', '246810'],
    ['Your code: 246-810', '246810'],
    ['24681099', '246810'],
    ['abc', ''],
  ])('%p → %p', (raw, expected) => expect(sanitizeOtp(raw)).toBe(expected));
});
