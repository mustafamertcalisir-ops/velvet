/**
 * Image processing (DEC-063): every uploaded image is identified by its
 * CONTENT (magic bytes — never the file name, extension or declared type),
 * then re-encoded with sharp: orientation applied, size bounded, and every
 * metadata block (EXIF, XMP, GPS, ICC comments) dropped. Only the re-encoded
 * bytes are ever stored as media.
 */
import sharp from 'sharp';
import { fail } from '../http/errors';

/** The upload limit for one photo, in bytes. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const MAX_EDGE = 2048;

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];
export const isAcceptedImageType = (v: unknown): v is AcceptedImageType => (ACCEPTED_IMAGE_TYPES as readonly unknown[]).includes(v);

const SIGNATURES: { type: AcceptedImageType; test: (b: Buffer) => boolean }[] = [
  { type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

/** The image type the bytes actually are, or null. */
export function sniffImageType(bytes: Buffer): AcceptedImageType | null {
  return SIGNATURES.find((s) => s.test(bytes))?.type ?? null;
}

export type SanitizedImage = { bytes: Buffer; contentType: 'image/jpeg'; width: number; height: number };

/** Verify by content, then re-encode: orientation applied, size bounded, ALL metadata dropped. */
export async function sanitizeImage(input: Buffer): Promise<SanitizedImage> {
  if (!sniffImageType(input)) return fail('VALIDATION_FAILED', { fields: ['photo'] });
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
      .rotate() // bake EXIF orientation into pixels before the metadata is discarded
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, contentType: 'image/jpeg', width: info.width, height: info.height };
  } catch {
    return fail('VALIDATION_FAILED', { fields: ['photo'] });
  }
}
