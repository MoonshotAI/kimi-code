/**
 * Shared video delivery ladder.
 *
 * A local video becomes a model-visible content part through one channel:
 * upload it via the provider's video upload channel (the tiny `ms://<id>`
 * reference), and only fall back to an inline base64 `data:` part when the
 * channel is missing or the upload fails for a non-auth reason. Two failures
 * are the exception and must surface instead of being masked behind an inline
 * payload: auth rejections (401/403), which drive credential refresh and a
 * clear auth error, and a cancelled delivery signal — the caller is tearing
 * the turn down, so the interruption propagates as the signal's abort reason
 * rather than silently delivering a degraded part.
 *
 * Both ReadMediaFile (videos the model reads itself) and the turn-level
 * prompt-media resolver (videos attached directly to a prompt) share this
 * ladder so their delivery and fallback semantics stay identical.
 */

import type { ContentPart, VideoUploadInput, VideoURLPart } from '@moonshot-ai/kosong';

import { ErrorCodes } from '../../errors';
import { abortReason } from '../../utils/abort';

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
 * Whether the provider's wire format can carry an inline `data:` video part.
 * The OpenAI family cannot: chat completions rejects the part outright and
 * the Responses adapter degrades it to an omitted-video placeholder, so an
 * inline fallback there only bloats history with bytes the model never sees.
 */
export function inlineVideoSupported(providerName: string): boolean {
  return providerName !== 'openai' && providerName !== 'openai-responses';
}

/**
 * Deliver a video through the provider's upload channel when available,
 * falling back to an inline base64 part when the channel is missing or the
 * upload fails for a non-auth reason — a failed upload must not turn the whole
 * delivery into an error. Auth rejections (401/403) are re-thrown so the
 * caller can surface them, and a cancelled `signal` re-throws its abort
 * reason so cancellation ends the delivery instead of degrading it.
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
      // The signal check (not the error's shape) decides cancellation: abort
      // rejections vary by provider, but our own aborted signal is definitive.
      if (signal?.aborted) throw abortReason(signal);
      if (isAuthUploadError(error)) throw error;
      // Fall through to the inline form.
    }
  }
  // Cancellation must also beat the no-uploader inline path: encoding up to
  // 100MB after the user aborted only produces a part the caller would then
  // persist against their intent.
  if (signal?.aborted) throw abortReason(signal);
  const base64 = Buffer.from(input.data).toString('base64');
  return {
    type: 'video_url',
    videoUrl: { url: `data:${input.mimeType};base64,${base64}` },
  };
}
