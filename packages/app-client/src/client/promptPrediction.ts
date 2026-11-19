import { ref } from 'vue';
import type { KimiWebApi, PromptPredictionCancelReason } from '@moonshot-ai/app-core/api';
import { track } from '../contracts';

export type PromptPredictionDismissReason = PromptPredictionCancelReason;

export interface PromptPredictionSuggestion {
  readonly sessionId: string;
  readonly turnId: number;
  readonly predictionId: string;
  readonly text: string;
  readonly accepted: boolean;
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
}

interface PredictionSuggestion extends ActivePrediction {
  readonly text: string;
  readonly accepted: boolean;
  readonly parked: boolean;
}

export function createPromptPrediction(host: {
  api: () => PredictionApi;
  canPredict: (sessionId: string) => boolean;
  hasEmptyInput: (sessionId: string) => boolean;
}) {
  const suggestion = ref<PredictionSuggestion | null>(null);
  let active: ActivePrediction | undefined;
  const pending = ref<{ readonly sessionId: string; readonly sourceId: string; readonly turnId: number } | undefined>(undefined);
  const attempted = new Set<string>();

  function cancelActive(reason: PromptPredictionDismissReason): void {
    const current = active;
    if (current === undefined) return;
    active = undefined;
    void current.api.cancelPromptPrediction(current.sessionId, current.predictionId, reason).catch(() => {});
  }

  function clearPending(sessionId?: string): boolean {
    if (pending.value === undefined || (sessionId !== undefined && pending.value.sessionId !== sessionId)) return false;
    pending.value = undefined;
    return true;
  }

  function dismissForSession(reason: PromptPredictionDismissReason, sessionId?: string): boolean {
    let dismissed = reason === 'queue' ? false : clearPending(sessionId);
    if (active !== undefined && (sessionId === undefined || active.sessionId === sessionId)) {
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
    dismissForSession('new_turn', sessionId);
  }

  function refresh(): void {
    const next = pending.value;
    if (next === undefined || active !== undefined || !host.canPredict(next.sessionId)) return;
    const key = `${next.sessionId}:${next.sourceId}`;
    pending.value = undefined;
    if (attempted.has(key)) return;
    attempted.add(key);
    const current: ActivePrediction = {
      api: host.api(),
      sessionId: next.sessionId,
      sourceId: next.sourceId,
      turnId: next.turnId,
      predictionId: crypto.randomUUID(),
      startedAt: Date.now(),
    };
    active = current;
    void current.api.predictNextPrompt(next.sessionId, {
      predictionId: current.predictionId,
      expectedTurnId: next.turnId,
    }).then((prediction) => {
      if (active !== current || prediction === null || !host.canPredict(next.sessionId)) return;
      suggestion.value = { ...current, text: prediction, accepted: false, parked: false };
      track('prediction_shown', {
        prediction_id: current.predictionId,
        turn_id: current.turnId,
        duration_ms: Date.now() - current.startedAt,
        prediction_chars: prediction.length,
      });
    }).catch(() => {}).finally(() => {
      if (active !== current) return;
      active = undefined;
      refresh();
    });
  }

  function handleTurnEnded(sessionId: string, sourceId: string, turnId: number, completed: boolean): void {
    dismissForSession('new_turn', sessionId);
    if (!completed) return;
    pending.value = { sessionId, sourceId, turnId };
    refresh();
  }

  function handleInput(): void {
    clearPending();
    cancelActive('input');
    const current = suggestion.value;
    if (current?.accepted === false) {
      suggestion.value = { ...current, parked: current.parked || !host.hasEmptyInput(current.sessionId) };
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

  function accept(key: 'tab' | 'right'): string | null {
    const current = suggestion.value;
    if (current === null || current.accepted || !host.canPredict(current.sessionId)) return null;
    suggestion.value = { ...current, accepted: true };
    track('prediction_accepted', {
      prediction_id: current.predictionId,
      turn_id: current.turnId,
      duration_ms: Date.now() - current.startedAt,
      prediction_chars: current.text.length,
      key,
    });
    return current.text;
  }

  return {
    suggestion,
    refresh,
    handleTurnStarted,
    handleTurnEnded,
    handleInput,
    handleSubmit,
    accept,
    dismiss: (reason: PromptPredictionDismissReason, sessionId?: string): boolean => dismissForSession(reason, sessionId),
  };
}
