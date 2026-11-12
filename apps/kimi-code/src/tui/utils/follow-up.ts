import type { FollowUpBehavior } from '../config';

export type EditorSubmitIntent = 'default' | 'opposite' | 'queue';
export type FollowUpDelivery = 'existing' | 'queue' | 'steer-draft';

export interface FollowUpRuntimeState {
  readonly streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  readonly isCompacting: boolean;
  readonly deferUserMessages: boolean;
  readonly goalActive: boolean;
  readonly steeringQueue: boolean;
}

export function bashInputIsBusy(
  runtime: Pick<
    FollowUpRuntimeState,
    'streamingPhase' | 'isCompacting' | 'deferUserMessages' | 'steeringQueue'
  >,
): boolean {
  return (
    runtime.streamingPhase !== 'idle' ||
    runtime.isCompacting ||
    runtime.deferUserMessages ||
    runtime.steeringQueue
  );
}

export function canSteerSingleDraft(runtime: FollowUpRuntimeState): boolean {
  return (
    !runtime.isCompacting &&
    !runtime.deferUserMessages &&
    !runtime.steeringQueue &&
    runtime.streamingPhase !== 'shell' &&
    (runtime.streamingPhase !== 'idle' || runtime.goalActive)
  );
}

export function resolveFollowUpDelivery(
  intent: EditorSubmitIntent,
  configured: FollowUpBehavior | undefined,
  runtime: FollowUpRuntimeState,
): FollowUpDelivery {
  if (
    !runtime.isCompacting &&
    !runtime.deferUserMessages &&
    !runtime.steeringQueue &&
    runtime.streamingPhase === 'idle' &&
    !runtime.goalActive
  ) {
    return 'existing';
  }
  const behavior = configured ?? 'queue';
  if (intent === 'queue') return 'queue';
  if (intent === 'opposite') return behavior === 'queue' ? 'steer-draft' : 'queue';
  return behavior === 'steer' ? 'steer-draft' : 'existing';
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
