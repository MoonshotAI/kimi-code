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
  parked: boolean;
  acceptKey: 'tab' | 'right' | undefined;
}

interface PredictionSuggestion extends ActivePrediction {
  readonly prediction: string;
  accepted: boolean;
}

export class PromptPredictionController {
  private active: ActivePrediction | undefined;
  private suggestion: PredictionSuggestion | undefined;
  private latestTurn: { readonly session: Session; readonly turnId: number } | undefined;
  private readonly attempted = new Set<string>();
  private suppressNextChange = false;

  constructor(private readonly host: PromptPredictionHost) {
    this.host.state.editor.setPromptPredictionPlaceholder(() => this.placeholder());
  }

  handleTurnStarted(): void {
    this.latestTurn = undefined;
    this.clear();
  }

  handleTurnEnded(event: TurnEndedEvent): void {
    this.latestTurn = undefined;
    this.clear();
    if (event.reason !== 'completed' || typeof event.turnId !== 'number') return;
    const session = this.host.session;
    if (session === undefined) return;
    this.latestTurn = { session, turnId: event.turnId };
    this.startPrediction();
  }

  private startPrediction(): boolean {
    const target = this.latestTurn;
    if (target === undefined || this.host.session !== target.session || !this.canUseEditor()) return false;
    const key = `${target.session.id}:${String(target.turnId)}`;
    if (this.attempted.has(key)) return false;
    this.attempted.add(key);
    const active: ActivePrediction = {
      predictionId: randomUUID(),
      turnId: target.turnId,
      session: target.session,
      startedAt: Date.now(),
      parked: false,
      acceptKey: undefined,
    };
    this.active = active;
    this.host.state.ui.requestRender();
    void target.session.predictNextPrompt({
      predictionId: active.predictionId,
      expectedTurnId: active.turnId,
    })
      .then((prediction) => {
        if (this.active !== active) return;
        this.active = undefined;
        if (prediction === null || this.host.session !== target.session || !this.canUsePrediction()) {
          this.host.state.ui.requestRender();
          return;
        }
        this.suggestion = {
          ...active,
          prediction,
          accepted: false,
          parked: active.parked || this.host.state.editor.getText().trim().length > 0,
        };
        this.host.state.editor.setPromptPrediction(prediction);
        this.host.track('prediction_shown', {
          prediction_id: active.predictionId,
          turn_id: active.turnId,
          duration_ms: Date.now() - active.startedAt,
          prediction_chars: prediction.length,
        });
        if (active.acceptKey !== undefined && this.canUseEditor()) this.accept(active.acceptKey);
        else this.host.state.ui.requestRender();
      })
      .catch(() => {
        if (this.active !== active) return;
        this.active = undefined;
        this.host.state.ui.requestRender();
      });
    return true;
  }

  handlePreInput(data: string): boolean {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      const key = matchesKey(data, Key.right) ? 'right' : 'tab';
      if (this.suggestion !== undefined && this.canUseEditor()) return this.accept(key);
      if (this.active !== undefined && this.canUseEditor()) {
        this.active.acceptKey = key;
        this.host.state.ui.requestRender();
        return true;
      }
      if (key === 'tab') return this.startPrediction();
    }
    return false;
  }

  handleEditorChange(text: string): void {
    if (this.suppressNextChange) {
      this.suppressNextChange = false;
      return;
    }
    if (this.active !== undefined) {
      this.active.parked = this.active.parked || text.trim().length > 0;
      if (text.trim().length > 0) this.active.acceptKey = undefined;
    }
    const suggestion = this.suggestion;
    if (suggestion?.accepted === false) suggestion.parked = suggestion.parked || text.trim().length > 0;
    if (suggestion?.accepted === true && text.trim().length === 0) {
      this.host.state.editor.setPromptPrediction(suggestion.prediction);
    }
    if (this.active !== undefined || suggestion?.accepted === false) this.host.state.ui.requestRender();
  }

  handleSubmit(text: string): void {
    const suggestion = this.suggestion;
    if (suggestion !== undefined && suggestion.accepted && text.trim().length > 0) {
      this.host.track('prediction_submitted', {
        prediction_id: suggestion.predictionId,
        turn_id: suggestion.turnId,
        duration_ms: Date.now() - suggestion.startedAt,
        prediction_chars: suggestion.prediction.length,
        edited: text !== suggestion.prediction,
      });
    }
    this.clear();
  }

  reset(): void {
    this.latestTurn = undefined;
    this.attempted.clear();
    this.clear();
  }

  dispose(): void {
    this.clear();
    this.host.state.editor.setPromptPredictionPlaceholder(undefined);
  }

  private accept(key: 'tab' | 'right'): boolean {
    const suggestion = this.suggestion;
    if (suggestion === undefined) return false;
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

  private placeholder(): string | undefined {
    if (!this.canUseEditor()) return undefined;
    return this.suggestion?.prediction;
  }

  private canUsePrediction(): boolean {
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
      state.livePane.pendingQuestion === null
    );
  }

  private canUseEditor(): boolean {
    const { state } = this.host;
    return (
      this.canUsePrediction() &&
      state.editor.inputMode === 'prompt' &&
      state.editor.getText().trim().length === 0 &&
      !state.editor.hasAutocompleteActivity()
    );
  }

  private clear(): void {
    const hadState = this.active !== undefined || this.suggestion !== undefined;
    this.active = undefined;
    this.suggestion = undefined;
    this.host.state.editor.setPromptPrediction(undefined);
    if (hadState) this.host.state.ui.requestRender();
  }
}
