import { resolveEndpoint } from '#human/llm/endpoint';
import type { ContentPart, ImageURLPart, MediaKind, VideoURLPart } from '#human/llm/message';
import type { ImageUploadInput, VideoUploadInput } from '#human/media/upload';
import {
  acceptsMime,
  acceptsSource,
  mediaSupportAt,
  type MediaKindSupport,
  type MediaPosition,
} from '#human/llm/protocol/rules/media';
import type { LlmCredentialProvider } from '#human/llm-requester/requester';
import type { Model } from '#/llm-adapter/model/catalog';
import { contentsOf } from '#human/llm/requester';
import type { InitializedLlmRequester } from '#/llm-adapter/model/generate';
import { ImageUploadUnsupportedError, VideoUploadUnsupportedError } from '#/llm-adapter/contract/errors';

export type ImageUploader = (
  input: ImageUploadInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<ImageURLPart>;

export type VideoUploader = (
  input: VideoUploadInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<VideoURLPart>;

export function supportsLlmUpload(
  request: InitializedLlmRequester,
  kind: MediaKind,
): boolean {
  return contentsOf(request).endpoint?.files?.kinds.has(kind) === true;
}

export function imageUploaderFor(
  model: Model,
  request: InitializedLlmRequester,
): ImageUploader | undefined {
  if (!supportsLlmUpload(request, 'image')) return undefined;
  return (input, options) => uploadImage(model, request, input, options?.signal);
}

export function videoUploaderFor(
  model: Model,
  request: InitializedLlmRequester,
): VideoUploader {
  return (input, options) => uploadVideo(model, request, input, options?.signal);
}

export async function uploadImage(
  model: Model,
  request: InitializedLlmRequester,
  input: ImageUploadInput,
  signal?: AbortSignal,
): Promise<ImageURLPart> {
  const files = contentsOf(request).endpoint?.files;
  if (!supportsLlmUpload(request, 'image') || files === undefined) {
    throw new ImageUploadUnsupportedError(
      `Model "${model.id}" (protocol=${model.protocol}) does not support image upload`,
    );
  }
  const uploaded = await files.upload(
    { ...input, kind: 'image' },
    { endpoint: await resolveEndpoint(contentsOf(request).endpoint), signal: signal ?? new AbortController().signal },
  );
  return { type: 'image_url', imageUrl: { url: uploaded.url, id: uploaded.id } };
}

export async function uploadVideo(
  model: Model,
  request: InitializedLlmRequester,
  input: VideoUploadInput,
  signal?: AbortSignal,
): Promise<VideoURLPart> {
  const files = contentsOf(request).endpoint?.files;
  if (!supportsLlmUpload(request, 'video') || files === undefined) {
    throw new VideoUploadUnsupportedError(
      `Model "${model.id}" (protocol=${model.protocol}) does not support video upload`,
    );
  }
  const uploaded = await files.upload(
    { ...input, kind: 'video' },
    { endpoint: await resolveEndpoint(contentsOf(request).endpoint), signal: signal ?? new AbortController().signal },
  );
  return { type: 'video_url', videoUrl: { url: uploaded.url, id: uploaded.id } };
}


export type { MediaKindSupport, MediaPosition } from '#human/llm/protocol/rules/media';

export function mediaSupportForRequest(
  request: InitializedLlmRequester,
  kind: MediaKind,
  position: MediaPosition,
): MediaKindSupport | undefined {
  const protocol = contentsOf(request).protocol?.base;
  return protocol === undefined ? undefined : mediaSupportAt(protocol.media, kind, position);
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
  request: InitializedLlmRequester,
): LlmCredentialProvider | undefined {
  return contentsOf(request).endpoint?.credentials;
}
