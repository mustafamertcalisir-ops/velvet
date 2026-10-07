/**
 * Base64 → bytes without platform globals (Hermes, web and Node alike).
 * Used to turn a prepared photo's data URI into the bytes of a direct upload.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

/** Null when the input is not valid base64. Whitespace is ignored. */
export function base64ToBytes(input: string): Uint8Array | null {
  const clean = input.replace(/\s+/g, '');
  if (clean.length % 4 !== 0) return null;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v: number[] = [];
    for (let k = 0; k < 4; k++) {
      const ch = clean.charCodeAt(i + k);
      if (ch === 61 /* = */ && i + k >= clean.length - padding) {
        v.push(0);
        continue;
      }
      const n = ch < 128 ? LOOKUP[ch]! : -1;
      if (n < 0) return null;
      v.push(n);
    }
    const triple = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    if (o < out.length) out[o++] = (triple >> 16) & 0xff;
    if (o < out.length) out[o++] = (triple >> 8) & 0xff;
    if (o < out.length) out[o++] = triple & 0xff;
  }
  return out;
}

/** `data:image/jpeg;base64,…` → its content type and bytes, or null. */
export function decodeImageDataUri(dataUri: string): { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array } | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(dataUri);
  if (!m) return null;
  const bytes = base64ToBytes(m[2]!);
  return bytes && bytes.length > 0 ? { contentType: m[1] as 'image/jpeg' | 'image/png' | 'image/webp', bytes } : null;
}
