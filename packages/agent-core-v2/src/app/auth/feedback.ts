import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type FeedbackAvailability =
  | { readonly kind: 'ready' }
  | { readonly kind: 'needs-login' }
  | { readonly kind: 'error'; readonly message: string };

export interface FeedbackSubmitInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
  readonly contact?: string;
  readonly info?: Record<string, unknown>;
}

export type FeedbackSubmitResult =
  | { readonly kind: 'ok'; readonly feedbackId: number }
  | { readonly kind: 'needs-login' }
  | { readonly kind: 'error'; readonly message: string };

export interface FeedbackUploadUrlInput {
  readonly feedbackId: number;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
}

export interface FeedbackUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export type FeedbackUploadUrlResult =
  | { readonly kind: 'ok'; readonly uploadId: number; readonly parts: readonly FeedbackUploadPart[] }
  | { readonly kind: 'needs-login' }
  | { readonly kind: 'error'; readonly message: string };

export interface FeedbackCompleteUploadInput {
  readonly uploadId: number;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
}

export type FeedbackCompleteResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'needs-login' }
  | { readonly kind: 'error'; readonly message: string };

export interface IFeedbackService {
  readonly _serviceBrand: undefined;

  availability(modelAlias?: string): Promise<FeedbackAvailability>;
  submit(input: FeedbackSubmitInput, modelAlias?: string): Promise<FeedbackSubmitResult>;
  createUploadUrl(
    input: FeedbackUploadUrlInput,
    modelAlias?: string,
  ): Promise<FeedbackUploadUrlResult>;
  completeUpload(
    input: FeedbackCompleteUploadInput,
    modelAlias?: string,
  ): Promise<FeedbackCompleteResult>;
}

export const IFeedbackService: ServiceIdentifier<IFeedbackService> =
  createDecorator<IFeedbackService>('feedbackService');
