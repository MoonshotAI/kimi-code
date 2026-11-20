import { createDecorator } from '#/_base/di/instantiation';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

export const AUTO_REVIEW_CIRCUIT_BREAKER_STOP_REASON = 'auto_review_circuit_breaker';
export const REVIEWER_READONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);

export type AutoReviewAuthorization = 'explicit' | 'ambiguous' | 'none';

export type AutoReviewDecision =
  | {
      readonly risk: 'low' | 'medium';
      readonly authorization?: AutoReviewAuthorization;
      readonly decision: 'allow';
    }
  | {
      readonly risk: 'medium' | 'high';
      readonly authorization?: AutoReviewAuthorization;
      readonly decision: 'deny';
      readonly reason?: string;
    };

export type AutoReviewResult =
  | { readonly kind: 'decision'; readonly decision: AutoReviewDecision }
  | { readonly kind: 'failed'; readonly reason: string };

export interface AutoReviewGateCallbacks {
  readonly onApproved?: (toolCallId: string) => void;
  readonly onAutoAllow?: (turnId: number) => void;
  readonly onAutoDeny?: (turnId: number) => boolean;
  readonly onAutoFailed?: (turnId: number) => void;
}

export interface IAutoReviewService {
  readonly _serviceBrand: undefined;
  review(
    context: ResolvedToolExecutionHookContext,
    trigger: string,
    signal?: AbortSignal,
  ): Promise<AutoReviewResult>;
}

export const IAutoReviewService = createDecorator<IAutoReviewService>('autoReviewService');
