import { v4 as randomUUID } from 'uuid';
import { ref, shallowRef, triggerRef } from 'vue';
import type { KimiWebApi, PromptPredictionCancelReason } from '@moonshot-ai/app-core/api';
import { track } from '../contracts';

export type PromptPredictionDismissReason = PromptPredictionCancelReason;

export interface PromptPredictionSuggestion {
  readonly sessionId: string;
  readonly turnId: number;
  readonly predictionId: string;
  readonly text: string;
  readonly accepted: boolean;
  readonly acceptedRevision: number;
  readonly parked: boolean;
}

type PredictionApi = Pick<KimiWebApi, 'predictNextPrompt' | 'cancelPromptPrediction'>;

interface ActivePrediction {
  readonly api: PredictionApi;
  readonly sessionId: string;
  readonly sourceId: string;
  readonly turnId: number;
  readonly predictionId: string;
  readonly startedAt: number;
  parked: boolean;
  acceptKey: 'tab' | 'right' | undefined;
}

interface PredictionSuggestion extends ActivePrediction {
  readonly text: string;
  readonly accepted: boolean;
  readonly acceptedRevision: number;
}

export function createPromptPrediction(host: {
  api: () => PredictionApi;
  isActiveSession: (sessionId: string) => boolean;
  canPredict: (sessionId: string) => boolean;
  hasEmptyInput: (sessionId: string) => boolean;
}) {
  const suggestion = ref<PredictionSuggestion | null>(null);
  const active = shallowRef<ActivePrediction | undefined>(undefined);
  const pending = ref<{ readonly sessionId: string; readonly sourceId: string; readonly turnId: number } | undefined>(undefined);
  const latestTurn = ref<{ readonly sessionId: string; readonly sourceId: string; readonly turnId: number } | undefined>(undefined);
  const attempted = new Set<string>();

  function cancelActive(reason: PromptPredictionDismissReason): void {
    const current = active.value;
    if (current === undefined) return;
    active.value = undefined;
    void current.api.cancelPromptPrediction(current.sessionId, current.predictionId, reason).catch(() => {});
  }

  function clearPending(sessionId?: string): boolean {
    if (pending.value === undefined || (sessionId !== undefined && pending.value.sessionId !== sessionId)) return false;
    pending.value = undefined;
    return true;
  }

  function dismissForSession(reason: PromptPredictionDismissReason, sessionId?: string): boolean {
    if (reason === 'session' && latestTurn.value !== undefined && (sessionId === undefined || latestTurn.value.sessionId === sessionId)) latestTurn.value = undefined;
    let dismissed = reason === 'queue' ? false : clearPending(sessionId);
    if (active.value !== undefined && (sessionId === undefined || active.value.sessionId === sessionId)) {
      cancelActive(reason);
      dismissed = true;
    }
    const current = suggestion.value;
    if (current === null || (sessionId !== undefined && current.sessionId !== sessionId)) return dismissed;
    if (current.accepted && reason === 'escape') return dismissed;
    suggestion.value = null;
    track('prediction_dismissed', {
      prediction_id: current.predictionId,
      turn_id: current.turnId,
      reason,
      accepted: current.accepted,
      duration_ms: Date.now() - current.startedAt,
      prediction_chars: current.text.length,
    });
    return true;
  }

  function handleTurnStarted(sessionId: string): void {
    if (!host.isActiveSession(sessionId)) return;
    latestTurn.value = undefined;
    dismissForSession('new_turn', sessionId);
  }

  function refresh(): void {
    const next = pending.value;
    if (next === undefined || active.value !== undefined || !host.canPredict(next.sessionId) || !host.hasEmptyInput(next.sessionId)) return;
    const key = `${next.sessionId}:${next.sourceId}`;
    pending.value = undefined;
    if (attempted.has(key)) return;
    attempted.add(key);
    const current: ActivePrediction = {
      api: host.api(),
      sessionId: next.sessionId,
      sourceId: next.sourceId,
      turnId: next.turnId,
      predictionId: randomUUID(),
      startedAt: Date.now(),
      parked: false,
      acceptKey: undefined,
    };
    active.value = current;
    void current.api.predictNextPrompt(next.sessionId, {
      predictionId: current.predictionId,
      expectedTurnId: next.turnId,
    }).then((prediction) => {
      if (active.value !== current || prediction === null || !host.canPredict(next.sessionId)) return;
      suggestion.value = { ...current, text: prediction, accepted: false, acceptedRevision: 0, parked: current.parked || !host.hasEmptyInput(current.sessionId) };
      track('prediction_shown', {
        prediction_id: current.predictionId,
        turn_id: current.turnId,
        duration_ms: Date.now() - current.startedAt,
        prediction_chars: prediction.length,
      });
      if (current.acceptKey !== undefined) accept(current.acceptKey);
    }).catch(() => {}).finally(() => {
      if (active.value !== current) return;
      active.value = undefined;
      refresh();
    });
  }

  function handleTurnEnded(sessionId: string, sourceId: string, turnId: number, completed: boolean): void {
    if (!host.isActiveSession(sessionId)) return;
    latestTurn.value = undefined;
    dismissForSession('new_turn', sessionId);
    if (!completed) return;
    latestTurn.value = { sessionId, sourceId, turnId };
    pending.value = latestTurn.value;
    refresh();
  }

  function handleInput(): void {
    clearPending();
    const current = active.value;
    if (current !== undefined) {
      const empty = host.hasEmptyInput(current.sessionId);
      current.parked = current.parked || !empty;
      if (!empty) current.acceptKey = undefined;
      triggerRef(active);
    }
    const currentSuggestion = suggestion.value;
    if (currentSuggestion?.accepted === false) {
      suggestion.value = { ...currentSuggestion, parked: currentSuggestion.parked || !host.hasEmptyInput(currentSuggestion.sessionId) };
    }
  }

  function handleSubmit(text: string): void {
    clearPending();
    const current = suggestion.value;
    if (current !== null) {
      if (current.accepted) {
        suggestion.value = null;
        track('prediction_submitted', {
          prediction_id: current.predictionId,
          turn_id: current.turnId,
          duration_ms: Date.now() - current.startedAt,
          prediction_chars: current.text.length,
          edited: text !== current.text,
        });
      } else {
        dismissForSession('submit');
      }
    }
    cancelActive('submit');
  }

  function canAttemptPrediction(): boolean {
    const target = latestTurn.value;
    return target !== undefined && !attempted.has(`${target.sessionId}:${target.sourceId}`);
  }

  function accept(key: 'tab' | 'right'): string | null {
    const current = suggestion.value;
    if (current !== null) {
      if (!host.canPredict(current.sessionId) || !host.hasEmptyInput(current.sessionId)) return null;
      suggestion.value = { ...current, accepted: true, acceptedRevision: current.acceptedRevision + 1 };
      track('prediction_accepted', {
        prediction_id: current.predictionId,
        turn_id: current.turnId,
        duration_ms: Date.now() - current.startedAt,
        prediction_chars: current.text.length,
        key,
      });
      return current.text;
    }
    const currentActive = active.value;
    if (currentActive !== undefined) {
      if (!host.canPredict(currentActive.sessionId) || !host.hasEmptyInput(currentActive.sessionId)) return null;
      currentActive.acceptKey = key;
      triggerRef(active);
      return null;
    }
    if (latestTurn.value === undefined) return null;
    pending.value = latestTurn.value;
    refresh();
    return null;
  }

  return {
    active,
    suggestion,
    predictionTarget: latestTurn,
    canAttemptPrediction,
    refresh,
    handleTurnStarted,
    handleTurnEnded,
    handleInput,
    handleSubmit,
    accept,
    dismiss: (reason: PromptPredictionDismissReason, sessionId?: string): boolean => dismissForSession(reason, sessionId),
  };
}
