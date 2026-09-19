import type { LlmModel } from '#/llm/model';

export interface MediaFileRef {
  readonly url: string;
  readonly id?: string;
}

export interface VideoUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export interface MediaVideoUploadOptions {
  readonly model: LlmModel;
  readonly signal?: AbortSignal;
}

export type MediaVideoUploader = (
  video: VideoUploadInput,
  options: MediaVideoUploadOptions,
) => Promise<MediaFileRef>;

export interface ImageUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
}

export type MediaImageUploader = (
  image: ImageUploadInput,
  options: MediaVideoUploadOptions,
) => Promise<MediaFileRef>;

export interface ProviderMediaContribution {
  readonly inlineVideo?: boolean;
  readonly uploadVideo?: MediaVideoUploader;
  readonly uploadImage?: MediaImageUploader;
}
