import { ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type {
  AppSessionRatingReport,
  AppSessionRatingResponse,
  AppSessionRatingView,
} from '@moonshot-ai/app-core/api';
import { getKimiWebApi } from '../client/deps';
import type { SessionRatingBinding } from '../contracts';
import { approvalsStore } from './approvals';
import { connectionStore } from './connection';
import { clientPinia } from './pinia';
import { promptStore } from './prompt';
import { sessionsStore } from './sessions';

export const SESSION_RATING_EVALUATION_DELAY_MS = 2000;
export const SESSION_RATING_EVALUATION_TIMEOUT_MS = 10_000;
export const SESSION_RATING_UNDO_WINDOW_MS = 3000;
export const SESSION_RATING_THANKS_VISIBLE_MS = 1600;

const CLOSED_VIEW: AppSessionRatingView = { phase: 'closed' };

export interface SessionRatingOptions {
  readonly canPrompt?: (sessionId: string) => boolean;
}

interface Evaluation {
  readonly turnId: string;
  readonly isUserWatching: () => boolean;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
}

interface Display {
  view: Exclude<AppSessionRatingView, { phase: 'closed' }>;
  readonly turnId: string;
  readonly isUserWatching: () => boolean;
  shown: boolean;
}

export const useSessionRatingStore = defineStore('kimi.sessionRating', () => {
  const enabled = ref(false);
  const displays = ref<Record<string, Display>>({});
  const evaluations = new Map<string, Evaluation>();
  const latestTurnBySession = new Map<string, string>();
  const phaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let canPrompt: (sessionId: string) => boolean = () => true;
  let removeWindowListeners: (() => void) | undefined;

  watch(
    () => enabled.value ? [...new Set([
      ...sessionsStore().sessions.flatMap((session) => (session.mainTurnActive === true ? [session.id] : [])),
      ...Object.keys(promptStore().inFlightBySession),
      ...Object.keys(promptStore().queuedBySession),
    ])].filter(sessionBusy) : [],
    (sessionIds) => {
      for (const sessionId of sessionIds) displace(sessionId);
    },
    { flush: 'sync' },
  );

  watch(
    () => enabled.value ? sessionsStore().activeSessionId : undefined,
    (_current, previous) => {
      if (previous === undefined) return;
      cancelEvaluation(previous);
      if (displays.value[previous]?.shown === false) drop(previous);
    },
    { flush: 'sync' },
  );

  watch(
    () => enabled.value && connectionStore().connected,
    (connected) => {
      if (!connected) cancelAllEvaluations();
    },
    { flush: 'sync' },
  );

  function enable(options: SessionRatingOptions = {}): void {
    canPrompt = options.canPrompt ?? (() => true);
    enabled.value = true;
    if (removeWindowListeners !== undefined || typeof window === 'undefined') return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') cancelAllEvaluations();
    };
    window.addEventListener('blur', cancelAllEvaluations);
    document.addEventListener('visibilitychange', onVisibilityChange);
    removeWindowListeners = () => {
      window.removeEventListener('blur', cancelAllEvaluations);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }

  function viewOf(sessionId: string): AppSessionRatingView {
    if (sessionBusy(sessionId)) return CLOSED_VIEW;
    return displays.value[sessionId]?.view ?? CLOSED_VIEW;
  }

  function observeTurn(sessionId: string, turnId: string | undefined, running: boolean): void {
    if (!enabled.value) return;
    if (running || latestTurnBySession.get(sessionId) !== turnId) displace(sessionId);
    if (turnId === undefined) latestTurnBySession.delete(sessionId);
    else latestTurnBySession.set(sessionId, turnId);
  }

  function noteMainTurnEnded(sessionId: string, turnId: string, isUserWatching: () => boolean): void {
    if (!enabled.value || latestTurnBySession.get(sessionId) !== turnId) return;
    if (evaluations.get(sessionId)?.turnId === turnId) return;
    cancelEvaluation(sessionId);
    const evaluation: Evaluation = {
      turnId,
      isUserWatching,
      deadline: Infinity,
      timer: setTimeout(() => {
        if (evaluations.get(sessionId) !== evaluation) return;
        if (!canDisplay(sessionId, evaluation) || viewOf(sessionId).phase !== 'closed') {
          cancelEvaluation(sessionId);
          return;
        }
        evaluation.deadline = Date.now() + SESSION_RATING_EVALUATION_TIMEOUT_MS;
        evaluation.timer = setTimeout(() => {
          if (evaluations.get(sessionId) === evaluation) cancelEvaluation(sessionId);
        }, SESSION_RATING_EVALUATION_TIMEOUT_MS);
        void evaluate(sessionId, evaluation);
      }, SESSION_RATING_EVALUATION_DELAY_MS),
    };
    evaluations.set(sessionId, evaluation);
  }

  async function evaluate(sessionId: string, evaluation: Evaluation): Promise<void> {
    try {
      const offer = await getKimiWebApi().evaluateSessionRating(sessionId, evaluation.turnId);
      if (evaluations.get(sessionId) !== evaluation) return;
      if (offer === null || Date.now() >= evaluation.deadline || !canDisplay(sessionId, evaluation)) return;
      if (viewOf(sessionId).phase !== 'closed') return;
      displays.value[sessionId] = {
        turnId: evaluation.turnId, isUserWatching: evaluation.isUserWatching,
        shown: false, view: { phase: 'open', ...offer },
      };
    } catch {
      return;
    } finally {
      if (evaluations.get(sessionId) === evaluation) cancelEvaluation(sessionId);
    }
  }

  function shown(sessionId: string, appearanceId: string): void {
    const display = displays.value[sessionId];
    if (display === undefined || display.shown || display.view.appearanceId !== appearanceId) return;
    if (!canDisplay(sessionId, display)) {
      drop(sessionId);
      return;
    }
    display.shown = true;
    report(sessionId, { op: 'shown', appearanceId });
  }

  function select(sessionId: string, appearanceId: string, response: AppSessionRatingResponse): void {
    const display = displays.value[sessionId];
    if (display?.view.phase !== 'open' || display.view.appearanceId !== appearanceId) return;
    const view = display.view;
    display.shown = true;
    display.view = { ...view, phase: 'pending', response };
    schedulePhase(sessionId, SESSION_RATING_UNDO_WINDOW_MS, () => {
      display.view = { ...view, phase: 'thanks', response };
      report(sessionId, { op: 'respond', appearanceId, response });
      schedulePhase(sessionId, SESSION_RATING_THANKS_VISIBLE_MS, () => drop(sessionId));
    });
  }

  function undo(sessionId: string, appearanceId: string): void {
    const display = displays.value[sessionId];
    if (display?.view.phase !== 'pending' || display.view.appearanceId !== appearanceId) return;
    clearPhaseTimer(sessionId);
    display.view = { phase: 'open', appearanceId, survey: display.view.survey };
  }

  function displace(sessionId: string): void {
    cancelEvaluation(sessionId);
    const display = displays.value[sessionId];
    const view = display?.view;
    drop(sessionId);
    if (view?.phase === 'pending') {
      report(sessionId, { op: 'respond', appearanceId: view.appearanceId, response: view.response });
    } else if (view?.phase === 'open' && display?.shown === true) {
      report(sessionId, { op: 'abandon', appearanceId: view.appearanceId });
    }
  }

  function endSession(sessionId: string): void {
    displace(sessionId);
    latestTurnBySession.delete(sessionId);
  }

  function report(sessionId: string, action: AppSessionRatingReport): void {
    void getKimiWebApi().reportSessionRating(sessionId, action).catch(() => undefined);
  }

  function canDisplay(sessionId: string, context: Pick<Evaluation, 'turnId' | 'isUserWatching'>): boolean {
    return enabled.value && connectionStore().connected &&
      latestTurnBySession.get(sessionId) === context.turnId &&
      context.isUserWatching() && !sessionBusy(sessionId) && !awaitingUser(sessionId) && canPrompt(sessionId);
  }

  function drop(sessionId: string): void {
    clearPhaseTimer(sessionId);
    delete displays.value[sessionId];
  }

  function sessionBusy(sessionId: string): boolean {
    const prompts = promptStore();
    return sessionsStore().sessions.find((session) => session.id === sessionId)?.mainTurnActive === true ||
      prompts.inFlightBySession[sessionId] === true ||
      (prompts.queuedBySession[sessionId]?.length ?? 0) > 0;
  }

  function awaitingUser(sessionId: string): boolean {
    const interactions = approvalsStore();
    return (interactions.approvalsBySession[sessionId]?.length ?? 0) > 0 ||
      (interactions.questionsBySession[sessionId]?.length ?? 0) > 0;
  }

  function schedulePhase(sessionId: string, ms: number, fn: () => void): void {
    clearPhaseTimer(sessionId);
    phaseTimers.set(sessionId, setTimeout(() => {
      phaseTimers.delete(sessionId);
      fn();
    }, ms));
  }

  function clearPhaseTimer(sessionId: string): void {
    const timer = phaseTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    phaseTimers.delete(sessionId);
  }

  function cancelEvaluation(sessionId: string): void {
    const evaluation = evaluations.get(sessionId);
    if (evaluation !== undefined) clearTimeout(evaluation.timer);
    evaluations.delete(sessionId);
  }

  function cancelAllEvaluations(): void {
    for (const sessionId of evaluations.keys()) cancelEvaluation(sessionId);
    for (const [sessionId, display] of Object.entries(displays.value)) {
      if (!display.shown) drop(sessionId);
    }
  }

  function $reset(): void {
    cancelAllEvaluations();
    for (const timer of phaseTimers.values()) clearTimeout(timer);
    phaseTimers.clear();
    displays.value = {};
    latestTurnBySession.clear();
    enabled.value = false;
    canPrompt = () => true;
    removeWindowListeners?.();
    removeWindowListeners = undefined;
  }

  return { enabled, displays, enable, viewOf, observeTurn, noteMainTurnEnded, shown, select, undo, endSession, $reset };
});

export function sessionRatingStore() {
  return useSessionRatingStore(clientPinia);
}

export function enableSessionRating(options: SessionRatingOptions = {}): SessionRatingBinding {
  const store = sessionRatingStore();
  store.enable(options);
  return {
    view: (sessionId) => store.viewOf(sessionId),
    shown: (sessionId, appearanceId) => store.shown(sessionId, appearanceId),
    select: (sessionId, appearanceId, response) => store.select(sessionId, appearanceId, response),
    undo: (sessionId, appearanceId) => store.undo(sessionId, appearanceId),
  };
}
