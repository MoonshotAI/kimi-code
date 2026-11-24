import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

export type AutoReviewOutcome =
  | { readonly decision: 'allow'; readonly risk: 'low' | 'medium' }
  | { readonly decision: 'deny'; readonly risk: 'medium' | 'high'; readonly reason?: string }
  | { readonly decision: 'failed'; readonly reason: string; readonly contextOverflow?: boolean };

export interface SessionReviewInput {
  readonly agentContext: AgentContext;
  readonly scopeContext: IAgentScopeContext;
  readonly mainModelAlias: string;
  readonly readHistory: () => readonly ContextMessage[];
  readonly readApprovedIds: () => ReadonlySet<string>;
  readonly context: ResolvedToolExecutionHookContext;
}

export interface SessionReviewRun {
  readonly modelAlias: string;
  readonly outcome: AutoReviewOutcome;
}

export interface ISessionAutoReviewService {
  readonly _serviceBrand: undefined;
  snapshotParentInstructions(scopeContext: IAgentScopeContext): IDisposable;
  execute(input: SessionReviewInput): Promise<SessionReviewRun>;
}

export interface IAutoReviewService {
  readonly _serviceBrand: undefined;
  review(
    context: ResolvedToolExecutionHookContext,
    trigger: string,
  ): Promise<AutoReviewOutcome>;
}

export const ISessionAutoReviewService =
  createDecorator<ISessionAutoReviewService>('sessionAutoReviewService');
export const IAutoReviewService = createDecorator<IAutoReviewService>('autoReviewService');
