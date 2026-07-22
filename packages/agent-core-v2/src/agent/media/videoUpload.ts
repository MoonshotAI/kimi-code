/**
 * `media` domain (L4) — shared video-upload fallback helpers.
 *
 * The provider video-upload attempt and its graceful fallbacks run in two
 * places — the `ReadMediaFile` tool (a model tool call) and the request-time
 * video resolver (a prompt's `kimi-file://` part) — and must agree on which
 * failures are auth failures (surfaced, never masked into a fallback) and
 * which protocols carry inline `video_url` on the wire. Pure helpers; no
 * scoped service.
 */

import { VideoUploadUnsupportedError } from '#/kosong/contract/errors';
import type { VideoURLPart } from '#/kosong/contract/message';
import type { Protocol } from '#/kosong/protocol/protocol';
import { ProtocolErrors } from '#/kosong/protocol/errors';

export function isVideoUploadAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === ProtocolErrors.codes.PROVIDER_AUTH_ERROR) return true;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return statusCode === 401 || statusCode === 403;
}

export function isVideoUploadUnsupportedError(error: unknown): error is VideoUploadUnsupportedError {
  return error instanceof VideoUploadUnsupportedError;
}

export function inlineVideoSupportedForProtocol(protocol: Protocol): boolean {
  return protocol !== 'openai' && protocol !== 'openai_responses';
}

export function inlineVideoPart(data: Uint8Array, mimeType: string): VideoURLPart {
  const base64 = Buffer.from(data).toString('base64');
  return { type: 'video_url', videoUrl: { url: `data:${mimeType};base64,${base64}` } };
}
