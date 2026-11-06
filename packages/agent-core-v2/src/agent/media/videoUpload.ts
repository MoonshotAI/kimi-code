import { errorStatusCode } from '#human/llm-requester/errors';
import type { VideoURLPart } from '#human/llm/message';
import { ProtocolErrors } from '#/llm-adapter/protocol/errors';

export function isMediaUploadAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === ProtocolErrors.codes.PROVIDER_AUTH_ERROR) return true;
  const status = errorStatusCode(error);
  return status === 401 || status === 403;
}

export function inlineVideoPart(data: Uint8Array, mimeType: string): VideoURLPart {
  const base64 = Buffer.from(data).toString('base64');
  return { type: 'video_url', videoUrl: { url: `data:${mimeType};base64,${base64}` } };
}
