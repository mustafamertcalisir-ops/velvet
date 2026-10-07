import { base64ToBytes, decodeImageDataUri } from '../base64';
import { toBase64 } from '../testing/toBase64';

describe('base64 decoding for direct uploads', () => {
  it('round-trips with and without padding', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 256]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) % 256);
      expect(Array.from(base64ToBytes(toBase64(bytes))!)).toEqual(Array.from(bytes));
    }
    expect(Array.from(base64ToBytes('TWFu')!)).toEqual([77, 97, 110]);
    expect(base64ToBytes('abc')).toBeNull();
    expect(base64ToBytes('ab$=')).toBeNull();
  });

  it('accepts only image data URIs', () => {
    expect(decodeImageDataUri('data:image/png;base64,iVBORw0KGgo=')?.contentType).toBe('image/png');
    expect(decodeImageDataUri('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(decodeImageDataUri('data:image/jpeg;base64,')).toBeNull();
  });
});
