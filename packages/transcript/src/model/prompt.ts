import type { PromptId } from './ids';
import type { TranscriptUserIdentity } from './identity';

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
  readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
  readonly actor?: TranscriptUserIdentity;
  readonly steeredBy?: TranscriptUserIdentity;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly steeredAt?: string;
}
