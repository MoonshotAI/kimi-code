import type { TurnStartedEvent } from '@moonshot-ai/kimi-code-sdk';
import {
  cloudSurveyPopupConfigFeed,
  mountSessionRating,
  ratingCooldownFile,
  type RatingConfigFeed,
  type RatingCooldownStore,
  type RatingEnvironment,
  SessionRatingLedger,
  type ResumedAgentSeed,
  type SessionRatingMount,
} from '@moonshot-ai/kimi-code-product/session-rating/node';
import type { RatingOffer, RatingResponse } from '@moonshot-ai/kimi-code-product/session-rating';
import { isTelemetryDisabledByEnv } from '@moonshot-ai/kimi-telemetry';
import { Key, matchesKey, Spacer } from '@moonshot-ai/pi-tui';

import { clientConfigs } from '#/utils/client-configs';
import { getDataDir } from '#/utils/paths';

import { SurveyPanelComponent, type SurveyPanelView } from '../components/panes/survey-panel';
import { CHROME_GUTTER } from '../constant/rendering';
import {
  SURVEY_DIGIT_DEBOUNCE_MS,
  SURVEY_DIGIT_RESPONSES,
  SURVEY_DISMISS_OPTION_INDEX,
  SURVEY_IDLE_EVALUATION_DELAY_MS,
  SURVEY_MIN_OPTIONS_WIDTH,
  SURVEY_MOUNT_PROTECTION_MS,
  SURVEY_OPTION_COUNT,
  SURVEY_ORDERED_LIST_START,
  SURVEY_PENDING_UNDO_WINDOW_MS,
  SURVEY_SINGLE_OPTION_DIGIT,
  SURVEY_THANKS_DURATION_MS,
  surveyMinTotalHeight,
} from '../constant/survey';
import type { TUIState } from '../tui-state';
import { printableChar } from '../utils/printable-key';
import { surveyUiVeto } from '../utils/survey-policy';
import type { BtwPanelController } from './btw-panel';

type RatingView =
  | { readonly phase: 'closed' }
  | (RatingOffer & { readonly phase: 'open' })
  | (RatingOffer & { readonly phase: 'pending' | 'thanks'; readonly response: RatingResponse });

export interface SurveyHost {
  readonly state: TUIState;
  readonly btwPanelController: BtwPanelController;
  track(
    event: string,
    props?: Record<string, unknown>,
    context?: { readonly sessionId?: string },
  ): void;
}

export interface SurveyControllerDeps {
  readonly configFeed?: RatingConfigFeed;
  readonly cooldown?: RatingCooldownStore;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
  readonly random?: () => number;
  readonly appearanceId?: () => string;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly telemetryDisabled?: () => boolean;
  readonly terminalHeight?: () => number;
  readonly terminalWidth?: () => number;
  readonly accessToken?: () => Promise<string | undefined>;
}

function modelRoute(appState: TUIState['appState']): RatingEnvironment['model'] {
  const entry = appState.availableModels[appState.model];
  if (entry === undefined) return { modelId: undefined, baseUrl: undefined };
  return {
    modelId: entry.model,
    baseUrl: entry.baseUrl ?? appState.availableProviders[entry.provider]?.baseUrl,
  };
}

export class SurveyController {
  private rating: SessionRatingMount;
  private readonly ledger: SessionRatingLedger;
  private ratingView: RatingView = { phase: 'closed' };
  private ratingSessionId = '';
  private phaseTimer: unknown;
  private readonly configFeed: RatingConfigFeed;
  private readonly cooldown: RatingCooldownStore;
  private readonly view: SurveyPanelView = { phase: 'open' };
  private mounted = false;
  private openAppearanceId: string | undefined;
  private openedAt = 0;
  private initialUserTurnCount: number | undefined = 0;
  private resumedAgents: Readonly<Record<string, ResumedAgentSeed>> | undefined;
  private lastTypedDigit: string | undefined;
  private openedEditorText: string | undefined;
  private idleTimer: unknown;
  private digitTimer: unknown;

  constructor(
    private readonly host: SurveyHost,
    private readonly deps: SurveyControllerDeps = {},
  ) {
    this.configFeed =
      deps.configFeed ?? cloudSurveyPopupConfigFeed(clientConfigs, deps.accessToken);
    this.cooldown = deps.cooldown ?? ratingCooldownFile(getDataDir());
    this.ledger = new SessionRatingLedger({
      telemetryDisabled: () => (this.deps.telemetryDisabled ?? isTelemetryDisabledByEnv)(),
      now: () => this.now(),
    });
    this.rating = this.createRating();
  }

  reset(): void {
    this.clearIdleTimer();
    this.clearDigitTimer();
    this.notifyDisplaced();
    this.rating.end();
    this.syncView({ phase: 'closed' });
    this.initialUserTurnCount = 0;
    this.resumedAgents = undefined;
    this.rating = this.createRating();
  }

  dispose(): void {
    this.clearIdleTimer();
    this.clearDigitTimer();
    this.clearPhaseTimer();
    this.rating.end();
    this.ledger.clear();
    this.syncView({ phase: 'closed' });
  }

  notifyTurnStarted(origin: TurnStartedEvent['origin']): void {
    this.clearIdleTimer();
    this.notifyDisplaced();
    this.rating.observe({ kind: 'turn-started', origin });
  }

  notifyTurnEnded(requestId?: string): void {
    this.rating.observe({ kind: 'turn-ended', requestId });
    this.clearIdleTimer();
    this.idleTimer = this.setT(() => {
      this.idleTimer = undefined;
      if (this.ratingView.phase !== 'closed' || surveyUiVeto(this.uiVetoInput()) !== undefined) return;
      const offer = this.rating.evaluate();
      if (offer === undefined) return;
      this.ratingSessionId = this.host.state.appState.sessionId ?? '';
      this.syncView({ phase: 'open', ...offer });
      this.ledger.report(this.ratingSessionId, { type: 'shown', appearanceId: offer.appearanceId });
    }, SURVEY_IDLE_EVALUATION_DELAY_MS);
  }

  notifyToolCallStarted(toolCallId: string, toolName: string): void {
    this.rating.observe({ kind: 'tool-call-started', toolCallId, toolName });
  }

  notifyToolCallEnded(toolCallId: string): void {
    this.rating.observe({ kind: 'tool-call-ended', toolCallId });
  }

  notifySubagentSpawned(event: {
    readonly parentToolCallId?: string;
    readonly swarmIndex?: number;
    readonly model?: string;
  }): void {
    this.rating.observe({
      kind: 'subagent-spawned',
      parentToolCallId: event.parentToolCallId,
      swarmIndex: event.swarmIndex,
      model: event.model,
    });
  }

  seedUserTurnCount(count: number | undefined): void {
    this.initialUserTurnCount = count;
  }

  seedFromResumedAgents(agents: Readonly<Record<string, ResumedAgentSeed>>): void {
    this.resumedAgents = agents;
  }

  notifyCompactionFinished(): void {
    this.rating.observe({ kind: 'compaction-completed' });
  }

  notifyInputModeChanged(mode: 'prompt' | 'bash'): void {
    if (mode !== 'bash') return;
    this.notifyDisplaced();
  }

  notifyDisplaced(): void {
    this.act('displace');
  }

  handlePreInput(data: string): boolean {
    const phase = this.ratingView.phase;
    if (phase === 'closed') return false;
    if (this.inMountProtection()) {
      const printable = printableChar(data);
      if (SURVEY_SINGLE_OPTION_DIGIT.test(printable)) {
        this.lastTypedDigit = printable;
      }
      return false;
    }
    if (this.host.state.editor.hasAutocompleteActivity()) return false;
    if (matchesKey(data, Key.escape)) {
      switch (phase) {
        case 'open':
          if (this.tooNarrow() || this.tooShort()) return false;
          this.act('dismiss');
          return true;
        case 'pending':
          this.act('undo');
          return true;
        case 'thanks':
          this.act('dismiss');
          return true;
      }
    }
    if (this.tooNarrow()) return false;
    if (this.tooShort()) return false;
    if (phase !== 'open') return false;
    const editor = this.host.state.editor;
    const empty = editor.getText().length === 0;
    const printable = printableChar(data);
    if (SURVEY_SINGLE_OPTION_DIGIT.test(printable)) {
      this.lastTypedDigit = printable;
      if (!empty) this.clearDigitTimer();
      return false;
    }
    this.lastTypedDigit = undefined;
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (!empty) this.clearDigitTimer();
      return false;
    }
    if (!empty) {
      this.clearDigitTimer();
      return false;
    }
    if (matchesKey(data, Key.left)) {
      this.moveHover(-1);
      return true;
    }
    if (matchesKey(data, Key.right)) {
      this.moveHover(1);
      return true;
    }
    return false;
  }

  handleEditorChange(text: string): void {
    if (this.ratingView.phase !== 'open') return;
    const wasTyped = text === this.lastTypedDigit;
    this.lastTypedDigit = undefined;
    if (this.inMountProtection()) {
      if (text.length === 0 || wasTyped) return;
      this.act('displace');
      return;
    }
    if (this.openedEditorText !== undefined) {
      if (text.length > 0 && text !== this.openedEditorText) {
        this.openedEditorText = undefined;
      } else if (text === this.openedEditorText && !wasTyped) {
        this.clearDigitTimer();
        return;
      }
    }
    const bashMode = this.host.state.editor.inputMode === 'bash';
    if (text.length === 0) {
      this.clearDigitTimer();
      return;
    }
    if (!bashMode && SURVEY_SINGLE_OPTION_DIGIT.test(text)) {
      if (!wasTyped) {
        this.act('displace');
        return;
      }
      this.clearDigitTimer();
      this.digitTimer = this.setT(() => {
        this.digitTimer = undefined;
        if (this.tooNarrow() || this.tooShort()) return;
        this.chooseDigit(text);
      }, SURVEY_DIGIT_DEBOUNCE_MS);
      return;
    }
    this.act('displace');
  }

  handleSubmit(text: string): boolean {
    if (this.ratingView.phase !== 'open') return false;
    if (this.inMountProtection()) return false;
    if (this.tooNarrow()) return false;
    if (this.tooShort()) return false;
    if (this.host.state.editor.inputMode === 'bash') {
      this.act('displace');
      return false;
    }
    if (SURVEY_SINGLE_OPTION_DIGIT.test(text) && text !== this.openedEditorText) {
      this.chooseDigit(text);
      return true;
    }
    if (text.trim().length === 0 && this.view.hoverIndex !== undefined) {
      this.chooseHovered();
      return true;
    }
    if (text.trim().length > 0) {
      this.act('displace');
    }
    return false;
  }

  private createRating(): SessionRatingMount {
    return mountSessionRating({
      environment: () => this.environment(),
      config: this.configFeed,
      cooldown: this.cooldown,
      ledger: this.ledger,
      track: (event, properties, context) => {
        if (context.sessionId.length > 0) {
          this.host.track(event, { ...properties }, { sessionId: context.sessionId });
        } else {
          this.host.track(event, { ...properties });
        }
      },
      now: this.deps.monotonicNow,
      wallNow: this.deps.wallNow,
      random: this.deps.random,
      appearanceId: this.deps.appearanceId,
    });
  }

  private environment(): RatingEnvironment {
    const { appState } = this.host.state;
    return {
      sessionId: appState.sessionId ?? '',
      currentModel: appState.model,
      model: modelRoute(appState),
      cumulativeTokens: appState.cumulativeTokens ?? 0,
      contextTokens: appState.contextTokens,
      permissionMode: appState.permissionMode,
      thinkingEffort: appState.thinkingEffort,
      busy: appState.streamingPhase !== 'idle' || appState.isCompacting,
      telemetryDisabled: (this.deps.telemetryDisabled ?? isTelemetryDisabledByEnv)(),
      ratingDisabled: appState.disableFeedbackSurvey === true,
      historyUserTurnCount: this.initialUserTurnCount,
      resumedAgents: this.resumedAgents,
    };
  }

  private uiVetoInput(): Parameters<typeof surveyUiVeto>[0] {
    const terminalWidth = this.terminalWidth();
    return {
      lastUserMessageStartsOrderedList: this.lastUserMessageStartsOrderedList(),
      promptActive: this.promptActive(),
      editorBashActive: this.host.state.editor.inputMode === 'bash',
      editorAutocompleteActive: this.host.state.editor.hasAutocompleteActivity(),
      externalEditorActive: this.host.state.externalEditorRunning,
      terminalWidth,
      terminalHeight: (this.deps.terminalHeight ?? (() => process.stdout.rows))(),
    };
  }

  private promptActive(): boolean {
    const { state } = this.host;
    return (
      state.editorReplacementMounted ||
      state.activeDialog !== null ||
      state.livePane.pendingApproval !== null ||
      state.livePane.pendingQuestion !== null ||
      state.tasksBrowser !== undefined ||
      this.host.btwPanelController.isActive()
    );
  }

  private lastUserMessageStartsOrderedList(): boolean {
    const entries = this.host.state.transcriptEntries;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (entry.kind !== 'user' || entry.bullet === '') continue;
      return SURVEY_ORDERED_LIST_START.test(entry.content);
    }
    return false;
  }

  private act(type: 'undo' | 'dismiss' | 'displace'): void {
    this.clearDigitTimer();
    const view = this.ratingView;
    if (view.phase === 'closed') return;
    if (type === 'undo') {
      if (view.phase !== 'pending') return;
      this.clearPhaseTimer();
      this.syncView({ phase: 'open', appearanceId: view.appearanceId, survey: view.survey });
      return;
    }
    if (type === 'dismiss' && view.phase === 'pending') return;
    this.clearPhaseTimer();
    this.syncView({ phase: 'closed' });
    if (view.phase === 'pending') {
      this.ledger.report(this.ratingSessionId, {
        type: 'respond', appearanceId: view.appearanceId, response: view.response,
      });
    } else if (view.phase === 'open') {
      this.ledger.report(this.ratingSessionId, type === 'dismiss'
        ? { type: 'respond', appearanceId: view.appearanceId, response: 'dismissed' }
        : { type: 'abandon', appearanceId: view.appearanceId });
    }
  }

  private select(response: RatingResponse): void {
    this.clearDigitTimer();
    const view = this.ratingView;
    if (view.phase !== 'open') return;
    this.syncView({ ...view, phase: 'pending', response });
    this.phaseTimer = this.setT(() => {
      this.phaseTimer = undefined;
      this.syncView({ ...view, phase: 'thanks', response });
      this.ledger.report(this.ratingSessionId, {
        type: 'respond', appearanceId: view.appearanceId, response,
      });
      this.phaseTimer = this.setT(() => {
        this.phaseTimer = undefined;
        this.syncView({ phase: 'closed' });
      }, SURVEY_THANKS_DURATION_MS);
    }, SURVEY_PENDING_UNDO_WINDOW_MS);
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer === undefined) return;
    this.clearT(this.phaseTimer);
    this.phaseTimer = undefined;
  }

  private syncView(view: RatingView): void {
    this.ratingView = view;
    if (view.phase === 'closed') {
      this.view.hoverIndex = undefined;
      this.applyClose();
      return;
    }
    if (view.phase === 'open' && view.appearanceId !== this.openAppearanceId) {
      this.openAppearanceId = view.appearanceId;
      this.openedAt = this.now();
      this.openedEditorText = this.host.state.editor.getText();
    }
    this.view.phase = view.phase;
    this.view.response = view.phase === 'open' ? undefined : view.response;
    if (view.phase !== 'open') this.view.hoverIndex = undefined;
    this.mountPanel();
    this.host.state.ui.requestRender();
  }

  private applyClose(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.lastTypedDigit = undefined;
    this.openedEditorText = undefined;
    this.host.state.surveyContainer.clear();
    this.host.state.ui.requestRender();
  }

  private mountPanel(): void {
    if (this.mounted) return;
    this.mounted = true;
    const container = this.host.state.surveyContainer;
    container.clear();
    container.addChild(new Spacer(1));
    container.addChild(new SurveyPanelComponent(this.view));
  }

  private chooseDigit(digit: string): void {
    const response = SURVEY_DIGIT_RESPONSES[digit];
    if (response === undefined) {
      this.act('dismiss');
    } else {
      this.select(response);
    }
    this.host.state.editor.setText('');
  }

  private chooseHovered(): void {
    const hoverIndex = this.view.hoverIndex;
    if (hoverIndex === undefined) return;
    if (hoverIndex === SURVEY_DISMISS_OPTION_INDEX) {
      this.act('dismiss');
      return;
    }
    const response = SURVEY_DIGIT_RESPONSES[String(hoverIndex + 1)];
    if (response === undefined) return;
    this.select(response);
  }

  private moveHover(delta: number): void {
    const current = this.view.hoverIndex;
    this.view.hoverIndex =
      current === undefined
        ? (delta > 0 ? 0 : SURVEY_OPTION_COUNT - 1)
        : (current + delta + SURVEY_OPTION_COUNT) % SURVEY_OPTION_COUNT;
    this.host.state.ui.requestRender();
  }

  private terminalWidth(): number {
    return (this.deps.terminalWidth ?? (() => process.stdout.columns))() - 2 * CHROME_GUTTER;
  }

  private tooNarrow(): boolean {
    return this.terminalWidth() < SURVEY_MIN_OPTIONS_WIDTH;
  }

  private tooShort(): boolean {
    return (
      (this.deps.terminalHeight ?? (() => process.stdout.rows))() <
      surveyMinTotalHeight(this.terminalWidth())
    );
  }

  private inMountProtection(): boolean {
    return this.now() - this.openedAt < SURVEY_MOUNT_PROTECTION_MS;
  }

  private now(): number {
    return (this.deps.monotonicNow ?? (() => performance.now()))();
  }

  private setT(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay)))(
      fn,
      ms,
    );
  }

  private clearT(handle: unknown): void {
    (
      this.deps.clearTimer ??
      ((value: unknown) => {
        clearTimeout(value as Parameters<typeof clearTimeout>[0]);
      })
    )(handle);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    this.clearT(this.idleTimer);
    this.idleTimer = undefined;
  }

  private clearDigitTimer(): void {
    if (this.digitTimer === undefined) return;
    this.clearT(this.digitTimer);
    this.digitTimer = undefined;
  }
}
