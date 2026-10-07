/** Reference base64 encoder for tests (no platform globals). Not used by the app. */
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (b === undefined ? '=' : A[(n >> 6) & 63]!) + (c === undefined ? '=' : A[n & 63]!);
  }
  return out;
}
