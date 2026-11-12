import type { FollowUpBehavior } from '../config';

export type EditorSubmitIntent = 'default' | 'opposite' | 'queue';
export type FollowUpDelivery = 'queue' | 'steer-draft';

export interface FollowUpRuntimeState {
  readonly streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  readonly isCompacting: boolean;
  readonly deferUserMessages: boolean;
  readonly goalActive: boolean;
  readonly steeringQueue: boolean;
  readonly hasCompactionBarrier: boolean;
  readonly dispatchPending: boolean;
}

export function canSteerSingleDraft(runtime: FollowUpRuntimeState): boolean {
  return (
    !runtime.isCompacting &&
    !runtime.deferUserMessages &&
    !runtime.steeringQueue &&
    !runtime.hasCompactionBarrier &&
    !runtime.dispatchPending &&
    runtime.streamingPhase !== 'shell' &&
    (runtime.streamingPhase !== 'idle' || runtime.goalActive)
  );
}

export function resolveFollowUpDelivery(
  intent: EditorSubmitIntent,
  configured: FollowUpBehavior | undefined,
  runtime: FollowUpRuntimeState,
): FollowUpDelivery | undefined {
  if (
    !runtime.isCompacting &&
    !runtime.deferUserMessages &&
    !runtime.steeringQueue &&
    !runtime.dispatchPending &&
    runtime.streamingPhase === 'idle' &&
    !runtime.goalActive
  ) {
    return undefined;
  }
  const behavior = configured ?? 'queue';
  if (intent === 'queue') return 'queue';
  if (intent === 'opposite') return behavior === 'queue' ? 'steer-draft' : 'queue';
  return behavior === 'steer' ? 'steer-draft' : undefined;
}

export function holdsForActiveGoal(
  message: { readonly mode?: string; readonly delivery?: 'prompt-only' },
  goalActive: boolean,
): boolean {
  return (
    (message.mode === undefined || message.mode === 'prompt') &&
    message.delivery === 'prompt-only' &&
    goalActive
  );
}
