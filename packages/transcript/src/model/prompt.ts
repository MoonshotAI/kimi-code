import type { PromptId } from './ids';

export type TranscriptPromptStatus =
  | 'running'
  | 'queued'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface TranscriptPrompt {
  readonly promptId: PromptId;
  readonly status: TranscriptPromptStatus;
  readonly userMessageId?: string;
  readonly content?: unknown;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly steeredAt?: string;
}
