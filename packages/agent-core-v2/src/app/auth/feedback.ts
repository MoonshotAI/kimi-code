import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ShellEnvironment } from '#/app/sessionExport/sessionExport';

export type FeedbackAttachmentLevel = 'none' | 'logs' | 'logs+codebase';

export interface FeedbackSessionPreview {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly files: readonly string[];
}

export type FeedbackAvailability =
  | { readonly kind: 'ready'; readonly session?: FeedbackSessionPreview }
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
  readonly attachmentLevel?: FeedbackAttachmentLevel;
  readonly workDir?: string;
  readonly installSource?: string;
  readonly shellEnv?: ShellEnvironment;
}

export type FeedbackSubmitResult =
  | { readonly kind: 'ok'; readonly feedbackId: number; readonly attachmentFailed?: boolean }
  | { readonly kind: 'needs-login' }
  | { readonly kind: 'error'; readonly message: string };

export interface IFeedbackService {
  readonly _serviceBrand: undefined;

  availability(modelAlias?: string, sessionId?: string): Promise<FeedbackAvailability>;
  submit(input: FeedbackSubmitInput, modelAlias?: string): Promise<FeedbackSubmitResult>;
}

export const IFeedbackService: ServiceIdentifier<IFeedbackService> =
  createDecorator<IFeedbackService>('feedbackService');
