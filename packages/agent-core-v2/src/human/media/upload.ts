import type { ImageURLPart, VideoURLPart } from '@moonshot-ai/core/llm/message';
import type { LlmModelSpec } from '@moonshot-ai/core/llm/request';

export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export interface MediaVideoUploadOptions {
  readonly model: LlmModelSpec;
  readonly signal?: AbortSignal;
}

export type MediaVideoUploader = (
  video: VideoUploadInput,
  options: MediaVideoUploadOptions,
) => Promise<VideoURLPart>;

export interface ImageUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export type MediaImageUploader = (
  image: ImageUploadInput,
  options: MediaVideoUploadOptions,
) => Promise<ImageURLPart>;

export interface ProviderMediaContribution {
  readonly inlineVideo?: boolean;
  readonly uploadVideo?: MediaVideoUploader;
  readonly uploadImage?: MediaImageUploader;
}
