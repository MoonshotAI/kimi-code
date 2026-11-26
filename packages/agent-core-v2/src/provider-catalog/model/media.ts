import { resolveEndpoint } from '@moonshot-ai/core/llm/endpoint';
import type { ContentPart, ImageURLPart, MediaKind, VideoURLPart } from '@moonshot-ai/core/llm/message';
import type { ImageUploadInput, VideoUploadInput } from '#human/media/upload';
import {
  acceptsMime,
  acceptsSource,
  mediaSupportAt,
  type MediaKindSupport,
  type MediaPosition,
} from '@moonshot-ai/core/llm/protocol/rules/media';
import type { LlmCredentialProvider, LlmRequest } from '@moonshot-ai/core/llm/request';
import { requestModelOf } from '#/provider-catalog/requester';
import { ImageUploadUnsupportedError, VideoUploadUnsupportedError } from '#/provider-catalog/errors';

export type ImageUploader = (
  input: ImageUploadInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<ImageURLPart>;

export type VideoUploader = (
  input: VideoUploadInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<VideoURLPart>;

export function supportsLlmUpload(
  request: LlmRequest,
  kind: MediaKind,
): boolean {
  return request.endpoint?.files?.kinds.has(kind) === true;
}

export function imageUploaderFor(
  request: LlmRequest,
): ImageUploader | undefined {
  if (!supportsLlmUpload(request, 'image')) return undefined;
  return (input, options) => uploadImage(request, input, options?.signal);
}

export function uploadFailureCheckFor(
  request: LlmRequest,
): ((id: string, signal: AbortSignal) => Promise<boolean>) | undefined {
  const endpoint = request.endpoint;
  const hasFailed = endpoint?.files?.hasFailed;
  if (hasFailed === undefined) return undefined;
  let resolvedEndpoint: ReturnType<typeof resolveEndpoint> | undefined;
  return async (id, signal) => {
    const resolved = await (resolvedEndpoint ??= resolveEndpoint(endpoint));
    signal.throwIfAborted();
    return hasFailed(id, { endpoint: resolved, signal });
  };
}

export function videoUploaderFor(
  request: LlmRequest,
): VideoUploader | undefined {
  if (!supportsLlmUpload(request, 'video')) return undefined;
  return (input, options) => uploadVideo(request, input, options?.signal);
}

export async function uploadImage(
  request: LlmRequest,
  input: ImageUploadInput,
  signal?: AbortSignal,
): Promise<ImageURLPart> {
  const files = request.endpoint?.files;
  if (!supportsLlmUpload(request, 'image') || files === undefined) {
    const model = requestModelOf(request);
    throw new ImageUploadUnsupportedError(
      `Model "${model.id}" (protocol=${model.protocol}) does not support image upload`,
    );
  }
  const uploaded = await files.upload(
    { ...input, kind: 'image' },
    { endpoint: await resolveEndpoint(request.endpoint), signal: signal ?? new AbortController().signal },
  );
  return { type: 'image_url', imageUrl: { url: uploaded.url, id: uploaded.id } };
}

export async function uploadVideo(
  request: LlmRequest,
  input: VideoUploadInput,
  signal?: AbortSignal,
): Promise<VideoURLPart> {
  const files = request.endpoint?.files;
  if (!supportsLlmUpload(request, 'video') || files === undefined) {
    const model = requestModelOf(request);
    throw new VideoUploadUnsupportedError(
      `Model "${model.id}" (protocol=${model.protocol}) does not support video upload`,
    );
  }
  const uploaded = await files.upload(
    { ...input, kind: 'video' },
    { endpoint: await resolveEndpoint(request.endpoint), signal: signal ?? new AbortController().signal },
  );
  return { type: 'video_url', videoUrl: { url: uploaded.url, id: uploaded.id } };
}


export type { MediaKindSupport, MediaPosition } from '@moonshot-ai/core/llm/protocol/rules/media';

export function mediaSupportForRequest(
  request: LlmRequest,
  kind: MediaKind,
  position: MediaPosition,
): MediaKindSupport | undefined {
  return mediaSupportAt(request.protocol.base.media, kind, position);
}

export function mediaAcceptsMime(support: MediaKindSupport, mimeType: string): boolean {
  return acceptsMime(support, mimeType);
}

export function mediaAcceptsSource(
  support: MediaKindSupport,
  part: ContentPart,
): boolean {
  if (part.type !== 'image_url' && part.type !== 'video_url') return false;
  return acceptsSource(support, part);
}

export function mediaCredentialProvider(
  request: LlmRequest,
): LlmCredentialProvider | undefined {
  return request.endpoint?.credentials;
}
