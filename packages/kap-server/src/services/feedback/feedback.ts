import { createDecorator } from '@moonshot-ai/agent-core-v2';

import type { FeedbackDiagnostics, FeedbackType } from '../../protocol/rest-feedback';

/**
 * `IFeedbackService` — forwards user feedback to the managed collection
 * backend with the managed provider's OAuth token, mirroring the CLI's
 * `/feedback` flow. The submit call stamps the host version, server OS, and
 * default model server-side; attachment uploads use the backend's
 * presigned-URL flow (`upload_url` / `upload_complete`).
 */
export interface FeedbackEntry {
  readonly content: string;
  readonly session_id: string;
  readonly contact?: string;
  readonly type?: FeedbackType;
  readonly title?: string;
  readonly diagnostics?: FeedbackDiagnostics;
  readonly agent_id?: string;
  readonly info?: Record<string, unknown>;
}

export interface FeedbackUploadUrlInput {
  readonly feedback_id: number;
  readonly file_name: string;
  readonly file_size: number;
  readonly file_hash: string;
}

export interface FeedbackUploadPart {
  readonly part_number: number;
  readonly url: string;
  readonly method: string;
  readonly size: number;
}

export interface FeedbackUploadUrlResult {
  readonly upload_id: number;
  readonly parts: readonly FeedbackUploadPart[];
}

export interface FeedbackUploadCompleteInput {
  readonly upload_id: number;
  readonly parts: readonly { readonly part_number: number; readonly etag: string }[];
}

export type FeedbackErrorReason = 'not_signed_in' | 'backend_error';

export class FeedbackError extends Error {
  constructor(
    readonly reason: FeedbackErrorReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FeedbackError';
  }
}

export interface IFeedbackService {
  readonly _serviceBrand: undefined;
  submit(entry: FeedbackEntry): Promise<{ feedbackId: number }>;
  createUploadUrl(input: FeedbackUploadUrlInput): Promise<FeedbackUploadUrlResult>;
  completeUpload(input: FeedbackUploadCompleteInput): Promise<void>;
}

export const IFeedbackService = createDecorator<IFeedbackService>('feedbackService');
