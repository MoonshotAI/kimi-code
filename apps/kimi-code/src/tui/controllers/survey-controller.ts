import { randomUUID } from 'node:crypto';

import { isTelemetryDisabledByEnv } from '@moonshot-ai/kimi-telemetry';
import { Key, matchesKey, Spacer } from '@moonshot-ai/pi-tui';

import {
  getSurveyPopupConfig,
  peekSurveyPopupConfig,
  peekSurveyPopupConfigFresh,
  type SurveyPopupConfig,
} from '#/utils/survey-popup-config';
import { readSurveyLastShownTime, writeSurveyLastShownTime } from '#/utils/survey-state-store';
import { currentKimiRegion } from '#/utils/region';

import { SurveyPanelComponent, type SurveyPanelView } from '../components/panes/survey-panel';
import { CHROME_GUTTER } from '../constant/rendering';
import { printableChar } from '../utils/printable-key';
import {
  SURVEY_DIGIT_DEBOUNCE_MS,
  SURVEY_IDLE_EVALUATION_DELAY_MS,
  SURVEY_MOUNT_PROTECTION_MS,
  SURVEY_PENDING_UNDO_WINDOW_MS,
  SURVEY_ORDERED_LIST_START,
  SURVEY_SINGLE_OPTION_DIGIT,
  SURVEY_OPTION_COUNT,
  SURVEY_DISMISS_OPTION_INDEX,
  SURVEY_DIGIT_RESPONSES,
  SURVEY_MIN_OPTIONS_WIDTH,
  surveyMinTotalHeight,
  SURVEY_CONFIG_REFRESH_INTERVAL_MS,
  SURVEY_THANKS_DURATION_MS,
} from '../constant/survey';
import type { TUIState } from '../tui-state';
import {
  buildSurveyEventProperties,
  evaluateSurveyGate,
  SURVEY_EVENT_NAMES,
  SURVEY_MACHINE_CLOSED,
  surveyMachineReduce,
  type LongContextArmGateInput,
  type SessionArmGateInput,
  type SharedArmGateInput,
  type SurveyAppearance,
  type SurveyEventEnvironmentFields,
  type SurveyKind,
  type SurveyMachineAction,
  type SurveyMachineEffect,
  type SurveyMachineState,
} from '../utils/survey-policy';
import type { BtwPanelController } from './btw-panel';

export interface SurveyHost {
  readonly state: TUIState;
  readonly btwPanelController: BtwPanelController;
  track(event: string, props?: Record<string, unknown>): void;
}

export interface SurveyControllerDeps {
  readonly config?: () => SurveyPopupConfig;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
  readonly random?: () => number;
  readonly appearanceId?: () => string;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly telemetryDisabled?: () => boolean;
  readonly feedbackSurveyDisabled?: () => boolean;
  readonly refreshConfig?: () => unknown;
  readonly terminalHeight?: () => number;
  readonly configFresh?: () => boolean;
  readonly terminalWidth?: () => number;
  readonly configRegion?: () => string;
  readonly accessToken?: () => Promise<string | undefined>;
  readonly readGlobalLastShown?: () => Promise<number | undefined>;
  readonly writeGlobalLastShown?: (wallTime: number) => void;
}

const defaultDeps = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  random: () => Math.random(),
  appearanceId: () => randomUUID(),
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (handle: unknown) => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
  telemetryDisabled: () => isTelemetryDisabledByEnv(),
  config: () => peekSurveyPopupConfig(),
  configFresh: () => peekSurveyPopupConfigFresh(),
  terminalHeight: () => process.stdout.rows,
  configRegion: () => currentKimiRegion(),
  terminalWidth: () => process.stdout.columns,
  readGlobalLastShown: readSurveyLastShownTime,
  writeGlobalLastShown: writeSurveyLastShownTime,
} satisfies Omit<
  Required<SurveyControllerDeps>,
  'feedbackSurveyDisabled' | 'refreshConfig' | 'accessToken'
>;

export class SurveyController {
  private machine: SurveyMachineState = SURVEY_MACHINE_CLOSED;
  private readonly view: SurveyPanelView = { phase: 'open' };
  private mounted = false;
  private mountedAt: number;
  private userTurnCount = 0;
  private lastShownAt: number | undefined;
  private userTurnsAtLastShown: number | undefined;
  private appearanceCount = 0;
  private globalLastShownAt: number | undefined;
  private longContextRollConsumed = false;
  private generation = 0;
  private idleSince: number | undefined;
  private openedAt = 0;
  private stickySample: { readonly turnCount: number; readonly value: number } | undefined;
  private lastTypedDigit: string | undefined;
  private openedEditorText: string | undefined;
  private idleTimer: unknown;
  private digitTimer: unknown;
  private phaseTimer: unknown;
  private toolCallCount = 0;
  private compactionCount = 0;
  private currentTurnUserOrigin: boolean | undefined;
  private evaluationPending = false;
  private appearanceConfig: SurveyPopupConfig | undefined;
  private configReady = false;
  private cooldownReady = false;
  private configRefreshedAt = 0;
  private coldRefreshAttemptedAt = 0;
  private configRegion: string | undefined;

  constructor(
    private readonly host: SurveyHost,
    private readonly deps: SurveyControllerDeps = {},
  ) {
    this.mountedAt = this.now();
    this.reset();
    this.refreshConfig();
    this.coldRefreshAttemptedAt = this.now();
  }

  reset(): void {
    this.generation += 1;
    this.clearIdleTimer();
    this.clearDigitTimer();
    this.clearPhaseTimer();
    this.applyClose();
    this.machine = SURVEY_MACHINE_CLOSED;
    this.mountedAt = this.now();
    this.userTurnCount = 0;
    this.lastShownAt = undefined;
    this.userTurnsAtLastShown = undefined;
    this.appearanceCount = 0;
    this.longContextRollConsumed = false;
    this.idleSince = undefined;
    this.stickySample = undefined;
    this.toolCallCount = 0;
    this.compactionCount = 0;
    this.appearanceConfig = undefined;
    this.currentTurnUserOrigin = undefined;
    this.evaluationPending = false;
    const generation = this.generation;
    this.cooldownReady = false;
    void (this.deps.readGlobalLastShown ?? defaultDeps.readGlobalLastShown)()
      .then((lastShown) => {
        if (this.generation !== generation) return;
        if (lastShown !== undefined) {
          this.globalLastShownAt = Math.max(lastShown, this.globalLastShownAt ?? 0);
        }
        this.cooldownReady = true;
      })
      .catch(() => {
        if (this.generation === generation) this.cooldownReady = true;
      });
  }

  dispose(): void {
    this.generation += 1;
    this.clearIdleTimer();
    this.clearDigitTimer();
    this.clearPhaseTimer();
    this.applyClose();
  }

  notifyTurnStarted(userOrigin: boolean): void {
    this.currentTurnUserOrigin = userOrigin;
    this.idleSince = undefined;
    this.clearIdleTimer();
    if (this.machine.phase !== 'closed') this.applyAction({ type: 'close-silently' });
    if (userOrigin) {
      this.userTurnCount += 1;
      this.evaluationPending = false;
    }
  }

  notifyTurnEnded(): void {
    if (this.currentTurnUserOrigin === true) this.evaluationPending = true;
    this.currentTurnUserOrigin = undefined;
    if (!this.evaluationPending) return;
    this.idleSince = this.now();
    this.clearIdleTimer();
    this.idleTimer = this.setT(() => {
      this.idleTimer = undefined;
      this.evaluationPending = false;
      this.evaluate();
    }, SURVEY_IDLE_EVALUATION_DELAY_MS);
  }

  notifyToolCallStarted(): void {
    this.toolCallCount += 1;
  }

  notifyCompactionFinished(): void {
    this.compactionCount += 1;
  }

  notifyInputModeChanged(mode: 'prompt' | 'bash'): void {
    if (mode !== 'bash') return;
    if (this.machine.phase === 'closed') return;
    if (this.machine.phase === 'open') {
      this.applyAction({ type: 'abandon' });
      return;
    }
    this.applyAction({ type: 'close-silently' });
  }

  closeSilently(): void {
    if (this.machine.phase === 'closed') return;
    this.applyAction({ type: 'close-silently' });
  }

  handlePreInput(data: string): boolean {
    const phase = this.machine.phase;
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
          this.applyAction({ type: 'dismiss' });
          return true;
        case 'pending':
          this.applyAction({ type: 'undo' });
          return true;
        case 'thanks':
          this.applyAction({ type: 'close-silently' });
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
    if (this.machine.phase !== 'open') return;
    const wasTyped = text === this.lastTypedDigit;
    this.lastTypedDigit = undefined;
    if (this.inMountProtection()) {
      if (text.length === 0 || wasTyped) return;
      this.applyAction({ type: 'abandon' });
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
        this.applyAction({ type: 'abandon' });
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
    this.applyAction({ type: 'abandon' });
  }

  handleSubmit(text: string): boolean {
    if (this.machine.phase !== 'open') return false;
    if (this.inMountProtection()) return false;
    if (this.tooNarrow()) return false;
    if (this.tooShort()) return false;
    if (this.host.state.editor.inputMode === 'bash') {
      this.applyAction({ type: 'abandon' });
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
      this.applyAction({ type: 'abandon' });
    }
    return false;
  }

  private evaluate(): void {
    if (this.machine.phase !== 'closed') return;
    if (!this.configReady) return;
    if (!this.cooldownReady) return;
    const region = (this.deps.configRegion ?? defaultDeps.configRegion)();
    const cacheCold = !(this.deps.configFresh ?? defaultDeps.configFresh)();
    if (
      cacheCold &&
      this.now() - this.coldRefreshAttemptedAt >= SURVEY_CONFIG_REFRESH_INTERVAL_MS
    ) {
      this.coldRefreshAttemptedAt = this.now();
      if (this.refreshConfig()) return;
    } else if (
      (region !== this.configRegion ||
        this.now() - this.configRefreshedAt >= SURVEY_CONFIG_REFRESH_INTERVAL_MS) &&
      this.refreshConfig()
    ) {
      return;
    }
    const config = (this.deps.config ?? defaultDeps.config)();
    const verdict = evaluateSurveyGate({ ...this.gateInputs(), config });
    if (verdict.longContextRollConsumed === true) this.longContextRollConsumed = true;
    if (!verdict.show) return;
    this.open(verdict.survey, config);
  }

  private gateInputs(): { session: SessionArmGateInput; longContext: LongContextArmGateInput } {
    const { appState } = this.host.state;
    const now = this.now();
    const shared: SharedArmGateInput = {
      phase: this.machine.phase,
      turnInProgress: appState.streamingPhase !== 'idle' || appState.isCompacting,
      idleForMs: this.idleSince === undefined ? 0 : now - this.idleSince,
      promptActive: this.promptActive(),
      editorBashActive: this.host.state.editor.inputMode === 'bash',
      editorAutocompleteActive: this.host.state.editor.hasAutocompleteActivity(),
      externalEditorActive: this.host.state.externalEditorRunning,
      terminalWidth: (this.deps.terminalWidth ?? defaultDeps.terminalWidth)() - 2 * CHROME_GUTTER,
      terminalHeight: (this.deps.terminalHeight ?? defaultDeps.terminalHeight)(),
      feedbackSurveyDisabled:
        this.deps.feedbackSurveyDisabled?.() ??
        this.host.state.appState.disableFeedbackSurvey === true,
      telemetryDisabled: (this.deps.telemetryDisabled ?? defaultDeps.telemetryDisabled)(),
      currentModel: appState.model,
      lastUserMessageStartsOrderedList: this.lastUserMessageStartsOrderedList(),
    };
    return {
      session: {
        ...shared,
        mountedForMs: now - this.mountedAt,
        userTurnsSinceMount: this.userTurnCount,
        msSinceLastShown: this.lastShownAt === undefined ? undefined : now - this.lastShownAt,
        userTurnsSinceLastShown:
          this.userTurnsAtLastShown === undefined
            ? undefined
            : this.userTurnCount - this.userTurnsAtLastShown,
        sample: this.currentSample(),
        msSinceGlobalLastShown:
          this.globalLastShownAt === undefined ? undefined : this.wallNow() - this.globalLastShownAt,
      },
      longContext: {
        ...shared,
        cumulativeTokens: appState.cumulativeTokens ?? 0,
        virtualContextTokens: appState.contextTokens,
        mountRollConsumed: this.longContextRollConsumed,
        drawMountRoll: () => (this.deps.random ?? defaultDeps.random)(),
      },
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

  private currentSample(): number {
    if (this.stickySample?.turnCount !== this.userTurnCount) {
      this.stickySample = {
        turnCount: this.userTurnCount,
        value: (this.deps.random ?? defaultDeps.random)(),
      };
    }
    return this.stickySample.value;
  }

  private open(survey: SurveyKind, config: SurveyPopupConfig): void {
    this.appearanceCount += 1;
    const appearance: SurveyAppearance = {
      survey,
      appearanceId: (this.deps.appearanceId ?? defaultDeps.appearanceId)(),
      appearanceIndex: this.appearanceCount,
    };
    const shownAt = this.now();
    this.appearanceConfig = config;
    this.applyAction({ type: 'open', appearance });
    if (this.machine.phase !== 'open') return;
    this.openedAt = shownAt;
    this.openedEditorText = this.host.state.editor.getText();
    this.lastShownAt = shownAt;
    this.userTurnsAtLastShown = this.userTurnCount;
    if (survey !== 'session') return;
    this.globalLastShownAt = this.wallNow();
    try {
      (this.deps.writeGlobalLastShown ?? defaultDeps.writeGlobalLastShown)(
        this.globalLastShownAt,
      );
    } catch {}
  }

  private applyAction(action: SurveyMachineAction): void {
    this.clearDigitTimer();
    this.clearPhaseTimer();
    const transition = surveyMachineReduce(this.machine, action);
    if (transition.state === this.machine && transition.effects.length === 0) return;
    const appearance = transition.state.appearance ?? this.machine.appearance;
    this.machine = transition.state;
    for (const effect of transition.effects) {
      this.runEffect(effect, appearance);
    }
    this.syncView();
  }

  private runEffect(effect: SurveyMachineEffect, appearance: SurveyAppearance | undefined): void {
    switch (effect.type) {
      case 'report': {
        if (appearance === undefined) return;
        this.host.track(
          SURVEY_EVENT_NAMES[appearance.survey],
          buildSurveyEventProperties(
            {
              event_type: effect.eventType,
              appearance_id: appearance.appearanceId,
              appearance_index: appearance.appearanceIndex,
              response: effect.response,
            },
            this.environmentFields(),
            this.appearanceConfig ?? (this.deps.config ?? defaultDeps.config)(),
          ),
        );
        return;
      }
      case 'schedule': {
        if (effect.timer === 'pending-settle') {
          this.phaseTimer = this.setT(() => {
            this.phaseTimer = undefined;
            this.applyAction({ type: 'settle' });
          }, SURVEY_PENDING_UNDO_WINDOW_MS);
        } else {
          this.phaseTimer = this.setT(() => {
            this.phaseTimer = undefined;
            this.applyAction({ type: 'thanks-elapsed' });
          }, SURVEY_THANKS_DURATION_MS);
        }
      }
    }
  }

  private syncView(): void {
    if (this.machine.phase === 'closed') {
      this.view.hoverIndex = undefined;
      this.applyClose();
      return;
    }
    this.view.phase = this.machine.phase;
    this.view.response =
      this.machine.response === undefined || this.machine.response === 'dismissed'
        ? undefined
        : this.machine.response;
    if (this.machine.phase !== 'open') this.view.hoverIndex = undefined;
    this.mount();
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

  private mount(): void {
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
      this.applyAction({ type: 'dismiss' });
    } else {
      this.applyAction({ type: 'select', response });
    }
    this.host.state.editor.setText('');
  }

  private chooseHovered(): void {
    const hoverIndex = this.view.hoverIndex;
    if (hoverIndex === undefined) return;
    if (hoverIndex === SURVEY_DISMISS_OPTION_INDEX) {
      this.applyAction({ type: 'dismiss' });
      return;
    }
    const response = SURVEY_DIGIT_RESPONSES[String(hoverIndex + 1)];
    if (response === undefined) return;
    this.applyAction({ type: 'select', response });
  }

  private moveHover(delta: number): void {
    const current = this.view.hoverIndex;
    this.view.hoverIndex =
      current === undefined
        ? (delta > 0 ? 0 : SURVEY_OPTION_COUNT - 1)
        : (current + delta + SURVEY_OPTION_COUNT) % SURVEY_OPTION_COUNT;
    this.host.state.ui.requestRender();
  }

  private environmentFields(): SurveyEventEnvironmentFields {
    const { appState } = this.host.state;
    return {
      current_model: appState.model,
      user_turn_count: this.userTurnCount,
      cumulative_tokens: appState.cumulativeTokens ?? 0,
      virtual_context_tokens: appState.contextTokens,
      tool_call_count: this.toolCallCount,
      compaction_count: this.compactionCount,
      permission_mode: appState.permissionMode,
      thinking_effort: appState.thinkingEffort,
    };
  }

  private refreshConfig(): boolean {
    this.configRefreshedAt = this.now();
    this.configRegion = (this.deps.configRegion ?? defaultDeps.configRegion)();
    const markReady = () => {
      this.configReady = true;
    };
    if (this.deps.refreshConfig !== undefined) {
      this.configReady = false;
      void Promise.resolve(this.deps.refreshConfig())
        .catch(() => undefined)
        .finally(markReady);
      return true;
    }
    const accessToken = this.deps.accessToken;
    if (accessToken === undefined) {
      markReady();
      return false;
    }
    this.configReady = false;
    void (async () => {
      const token = await accessToken();
      await getSurveyPopupConfig({ accessToken: token });
    })()
      .catch(() => undefined)
      .finally(markReady);
    return true;
  }

  private tooNarrow(): boolean {
    return (
      (this.deps.terminalWidth ?? defaultDeps.terminalWidth)() - 2 * CHROME_GUTTER <
      SURVEY_MIN_OPTIONS_WIDTH
    );
  }

  private tooShort(): boolean {
    return (
      (this.deps.terminalHeight ?? defaultDeps.terminalHeight)() <
      surveyMinTotalHeight(
        (this.deps.terminalWidth ?? defaultDeps.terminalWidth)() - 2 * CHROME_GUTTER,
      )
    );
  }

  private inMountProtection(): boolean {
    return this.now() - this.openedAt < SURVEY_MOUNT_PROTECTION_MS;
  }

  private now(): number {
    return (this.deps.monotonicNow ?? defaultDeps.monotonicNow)();
  }

  private wallNow(): number {
    return (this.deps.wallNow ?? defaultDeps.wallNow)();
  }

  private setT(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? defaultDeps.setTimer)(fn, ms);
  }

  private clearT(handle: unknown): void {
    (this.deps.clearTimer ?? defaultDeps.clearTimer)(handle);
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

  private clearPhaseTimer(): void {
    if (this.phaseTimer === undefined) return;
    this.clearT(this.phaseTimer);
    this.phaseTimer = undefined;
  }
}
