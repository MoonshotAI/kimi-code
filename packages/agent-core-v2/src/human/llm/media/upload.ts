import type { VideoURLPart } from '#/llm/message';
import type { LlmModel } from '#/llm/model';

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
) => Promise<VideoURLPart>;

export interface ProviderMediaContribution {
  readonly inlineVideo?: boolean;
  readonly uploadVideo?: MediaVideoUploader;
}
