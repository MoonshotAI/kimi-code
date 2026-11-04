import { createDecorator } from '#/_base/di/instantiation';
import type { PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

export type AutoReviewDecision =
  | { readonly risk: 'low' | 'medium'; readonly decision: 'allow' }
  | { readonly risk: 'medium' | 'high'; readonly decision: 'deny'; readonly reason?: string };

export type AutoReviewResult =
  | { readonly kind: 'decision'; readonly decision: AutoReviewDecision }
  | { readonly kind: 'failed'; readonly reason: string };

export interface IAutoReviewService {
  readonly _serviceBrand: undefined;
  review(context: ResolvedToolExecutionHookContext): Promise<AutoReviewResult>;
}

export const IAutoReviewService = createDecorator<IAutoReviewService>('autoReviewService');

export interface IAutoReviewGate {
  readonly _serviceBrand: undefined;
  readonly name: string;
  evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined>;
}

export const IAutoReviewGate = createDecorator<IAutoReviewGate>('autoReviewGate');
