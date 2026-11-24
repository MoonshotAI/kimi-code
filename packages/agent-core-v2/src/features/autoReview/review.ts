import { createDecorator } from '#/_base/di/instantiation';
import type { DeadlineAbortSignal } from '#/_base/utils/abort';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { Message } from '@moonshot-ai/core/llm/message';

import type { ReviewText } from './context';

export type AutoReviewOutcome =
  | { readonly decision: 'allow'; readonly risk: 'low' | 'medium' }
  | { readonly decision: 'deny'; readonly risk: 'medium' | 'high'; readonly reason?: string }
  | { readonly decision: 'failed'; readonly reason: string; readonly contextOverflow?: boolean };

export interface ProjectInstructions {
  readonly agentsMd?: string;
  readonly agentsMdPaths?: readonly string[];
}

export interface SessionReviewInput {
  readonly agentContext: AgentContext;
  readonly turnId: number;
  readonly mainModelAlias: string;
  readonly deadline: DeadlineAbortSignal;
  readonly messages: readonly Message[];
}

export interface SessionReviewRun {
  readonly modelAlias: string;
  readonly outcome: AutoReviewOutcome;
}

export interface ISessionAutoReviewService {
  readonly _serviceBrand: undefined;
  projectInstructions(): Promise<ProjectInstructions>;
  execute(input: SessionReviewInput): Promise<SessionReviewRun>;
}

export interface IAutoReviewService {
  readonly _serviceBrand: undefined;
  humanAuthorization(): readonly ReviewText[];
  review(
    context: ResolvedToolExecutionHookContext,
    trigger: string,
  ): Promise<AutoReviewOutcome>;
}

export const ISessionAutoReviewService =
  createDecorator<ISessionAutoReviewService>('sessionAutoReviewService');
export const IAutoReviewService = createDecorator<IAutoReviewService>('autoReviewService');
