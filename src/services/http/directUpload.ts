/**
 * Direct upload over HTTP (DEC-063, docs/MEDIA_ARCHITECTURE.md):
 *
 *   1. POST /media/uploads                 → a short-lived signed PUT url
 *   2. PUT the bytes to private storage    (never through the API as JSON)
 *   3. POST /media/uploads/{id}/complete   → the processed media
 *
 * The prepared photo arrives as a data URI (it was re-encoded on the device);
 * it is decoded to bytes here and sent as the raw body of the PUT.
 */
import { decodeImageDataUri } from '@/lib/base64';
import { ROUTES, type CompletedUpload, type MediaClass, type UploadAuthorization } from '../api/contract';
import type { ApiResult, Session } from '../api/types';
import type { HttpClient } from './httpClient';

export async function directUpload(
  call: HttpClient,
  session: Session,
  photo: { dataUri: string },
  target: { mediaClass: MediaClass; requestId?: string | null },
): Promise<ApiResult<CompletedUpload>> {
  const decoded = decodeImageDataUri(photo.dataUri);
  if (!decoded) return { ok: false, error: { kind: 'validation', fields: ['photo'] } };
  const auth = await call<UploadAuthorization>(ROUTES.createUpload, {
    session,
    body: { mediaClass: target.mediaClass, contentType: decoded.contentType, byteLength: decoded.bytes.length, requestId: target.requestId ?? null },
  });
  if (!auth.ok) return auth;
  const put = await call.putBytes(auth.value.upload.url, auth.value.upload.headers, decoded.bytes);
  if (!put.ok) return put;
  return call<CompletedUpload>(ROUTES.completeUpload(auth.value.uploadId), { session });
}
