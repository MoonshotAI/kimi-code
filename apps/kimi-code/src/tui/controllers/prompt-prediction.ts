import { randomUUID } from 'node:crypto';

import { Key, matchesKey } from '@moonshot-ai/pi-tui';
import type { Session, TurnEndedEvent } from '@moonshot-ai/kimi-code-sdk';

import { isExperimentalFlagEnabled } from '../commands/experimental-flags';
import type { TUIState } from '../tui-state';

export interface PromptPredictionHost {
  readonly state: TUIState;
  readonly session: Session | undefined;
  readonly aborted: boolean;
  track(event: string, props?: Record<string, unknown>): void;
}

interface ActivePrediction {
  readonly predictionId: string;
  readonly turnId: number;
  readonly session: Session;
  readonly startedAt: number;
}

interface PredictionSuggestion extends ActivePrediction {
  readonly prediction: string;
  accepted: boolean;
}

type DismissReason =
  | 'input'
  | 'escape'
  | 'new_turn'
  | 'session'
  | 'dialog'
  | 'queue'
  | 'submit'
  | 'plan'
  | 'shutdown';

export class PromptPredictionController {
  private active: ActivePrediction | undefined;
  private suggestion: PredictionSuggestion | undefined;
  private readonly attempted = new Set<string>();
  private suppressNextChange = false;

  constructor(private readonly host: PromptPredictionHost) {}

  handlePlanModeChanged(planMode: boolean): void {
    if (planMode) this.dismiss('plan');
  }

  handleTurnStarted(): void {
    this.dismiss('new_turn');
  }

  handleTurnEnded(event: TurnEndedEvent): void {
    this.dismiss('new_turn');
    if (event.reason !== 'completed' || typeof event.turnId !== 'number') return;
    const session = this.host.session;
    if (session === undefined || !this.canUseEditor()) return;
    const key = `${session.id}:${String(event.turnId)}`;
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    const active: ActivePrediction = {
      predictionId: randomUUID(),
      turnId: event.turnId,
      session,
      startedAt: Date.now(),
    };
    this.active = active;
    void session.predictNextPrompt({
      predictionId: active.predictionId,
      expectedTurnId: active.turnId,
    })
      .then((prediction) => {
        if (this.active !== active) return;
        this.active = undefined;
        if (prediction === null || this.host.session !== session || !this.canUseEditor()) return;
        this.suggestion = { ...active, prediction, accepted: false };
        this.host.state.editor.setPromptPrediction(prediction);
        this.host.state.ui.requestRender();
        this.host.track('prediction_shown', {
          prediction_id: active.predictionId,
          turn_id: active.turnId,
          duration_ms: Date.now() - active.startedAt,
          prediction_chars: prediction.length,
        });
      })
      .catch(() => {
        if (this.active === active) this.active = undefined;
      });
  }

  handlePreInput(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      const hadPrediction = this.active !== undefined || this.suggestion !== undefined;
      const autocomplete = this.host.state.editor.hasAutocompleteActivity();
      this.dismiss('escape');
      return hadPrediction && !autocomplete;
    }
    if (
      (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) &&
      this.suggestion?.accepted === false &&
      this.host.state.editor.inputMode === 'prompt' &&
      !this.host.state.editor.hasAutocompleteActivity()
    ) {
      return this.accept(matchesKey(data, Key.right) ? 'right' : 'tab');
    }
    return false;
  }

  handleEditorChange(_text: string): void {
    if (this.suppressNextChange) {
      this.suppressNextChange = false;
      return;
    }
    if (this.active !== undefined) this.cancelActive('input');
    if (this.suggestion?.accepted === false) this.dismiss('input');
  }

  handleSubmit(text: string): void {
    const suggestion = this.suggestion;
    if (suggestion !== undefined) {
      if (suggestion.accepted && text.trim().length > 0) {
        this.host.track('prediction_submitted', {
          prediction_id: suggestion.predictionId,
          turn_id: suggestion.turnId,
          duration_ms: Date.now() - suggestion.startedAt,
          prediction_chars: suggestion.prediction.length,
          edited: text !== suggestion.prediction,
        });
        this.suggestion = undefined;
      } else {
        this.dismiss('submit');
      }
    }
    if (this.active !== undefined) this.cancelActive('submit');
  }

  notifyDisplaced(): void {
    this.dismiss('dialog');
  }

  handleQueueChange(): void {
    if (
      this.host.state.queuedMessages.length > 0 ||
      this.host.state.queuedMessageDispatchPending
    ) {
      this.dismiss('queue');
    }
  }

  reset(): void {
    this.attempted.clear();
    this.dismiss('session');
  }

  dispose(): void {
    this.dismiss('shutdown');
  }

  private accept(key: 'tab' | 'right'): boolean {
    const suggestion = this.suggestion;
    if (suggestion === undefined || suggestion.accepted) return false;
    const text = this.host.state.editor.getPromptPrediction();
    if (text === undefined) return false;
    this.suppressNextChange = true;
    try {
      if (!this.host.state.editor.acceptPromptPrediction()) return false;
    } finally {
      this.suppressNextChange = false;
    }
    suggestion.accepted = true;
    this.host.state.ui.requestRender();
    this.host.track('prediction_accepted', {
      prediction_id: suggestion.predictionId,
      turn_id: suggestion.turnId,
      duration_ms: Date.now() - suggestion.startedAt,
      prediction_chars: text.length,
      key,
    });
    return true;
  }

  private canUseEditor(): boolean {
    const { state } = this.host;
    return (
      !this.host.aborted &&
      isExperimentalFlagEnabled('prompt_prediction') &&
      state.startupState === 'ready' &&
      state.appState.streamingPhase === 'idle' &&
      !state.appState.isCompacting &&
      !state.appState.isReplaying &&
      !state.appState.planMode &&
      state.queuedMessages.length === 0 &&
      !state.queuedMessageDispatchPending &&
      state.activeDialog === null &&
      !state.editorReplacementMounted &&
      state.tasksBrowser === undefined &&
      !state.externalEditorRunning &&
      state.livePane.pendingApproval === null &&
      state.livePane.pendingQuestion === null &&
      state.editor.inputMode === 'prompt' &&
      state.editor.getText().length === 0 &&
      !state.editor.hasAutocompleteActivity()
    );
  }

  private dismiss(reason: DismissReason): void {
    if (this.active !== undefined) this.cancelActive(reason);
    const suggestion = this.suggestion;
    this.suggestion = undefined;
    this.host.state.editor.setPromptPrediction(undefined);
    if (suggestion === undefined) return;
    this.host.state.ui.requestRender();
    this.host.track('prediction_dismissed', {
      prediction_id: suggestion.predictionId,
      turn_id: suggestion.turnId,
      reason,
      accepted: suggestion.accepted,
      duration_ms: Date.now() - suggestion.startedAt,
      prediction_chars: suggestion.prediction.length,
    });
  }

  private cancelActive(reason: DismissReason): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    void active.session.cancelPromptPrediction(active.predictionId, reason).catch(() => {});
  }
}
