/**
 * Shared video delivery ladder.
 *
 * A local video becomes a model-visible content part through one channel:
 * upload it via the provider's video upload channel (the tiny `ms://<id>`
 * reference), and only fall back to an inline base64 `data:` part when the
 * channel is missing or the upload fails for a non-auth reason. Auth
 * rejections (401/403) are the exception: they must surface so credential
 * refresh runs and the user sees a clear auth error, instead of being masked
 * behind an inline payload the next request would also reject.
 *
 * Both ReadMediaFile (videos the model reads itself) and the turn-level
 * prompt-media resolver (videos attached directly to a prompt) share this
 * ladder so their delivery and fallback semantics stay identical.
 */

import type { ContentPart, VideoUploadInput, VideoURLPart } from '@moonshot-ai/kosong';

import { ErrorCodes } from '../../errors';

/** Uploads a local video and returns the provider-issued `video_url` part. */
export type VideoUploader = (
  input: VideoUploadInput,
  options?: { signal?: AbortSignal },
) => Promise<VideoURLPart>;

/**
 * Auth rejections from the upload channel that must surface (they drive
 * credential refresh and a clear auth error). The auth layer wraps provider
 * 401/403s as `provider.auth_error`; a raw status-coded error is matched
 * directly.
 */
export function isAuthUploadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === ErrorCodes.PROVIDER_AUTH_ERROR) return true;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return statusCode === 401 || statusCode === 403;
}

/**
 * Deliver a video through the provider's upload channel when available,
 * falling back to an inline base64 part when the channel is missing or the
 * upload fails for a non-auth reason — a failed upload must not turn the whole
 * delivery into an error. Auth rejections (401/403) are re-thrown so the
 * caller can surface them.
 */
export async function deliverVideoContent(
  input: VideoUploadInput,
  uploader: VideoUploader | undefined,
  signal?: AbortSignal,
): Promise<ContentPart> {
  if (uploader !== undefined) {
    try {
      // Call with a single argument when there is no signal to thread, so
      // callers that never cancel (ReadMediaFile) invoke the channel exactly
      // as before signal support existed.
      return await (signal === undefined ? uploader(input) : uploader(input, { signal }));
    } catch (error) {
      if (isAuthUploadError(error)) throw error;
      // Fall through to the inline form.
    }
  }
  const base64 = Buffer.from(input.data).toString('base64');
  return {
    type: 'video_url',
    videoUrl: { url: `data:${input.mimeType};base64,${base64}` },
  };
}
