import { describe, expect, it, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import {
  SurveyController,
  type SurveyControllerDeps,
  type SurveyHost,
} from '#/tui/controllers/survey-controller';
import type { TranscriptEntry } from '#/tui/types';
import { DEFAULT_SURVEY_POPUP_CONFIG } from '#/utils/survey-popup-config';

const mocks = vi.hoisted(() => ({
  getSurveyPopupConfig: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('#/utils/survey-popup-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/survey-popup-config')>();
  return {
    ...actual,
    getSurveyPopupConfig: mocks.getSurveyPopupConfig,
  };
});

const ESC = '\u001B';
const CSI_LEFT = '\u001B[D';
const CSI_RIGHT = '\u001B[C';
const CSI_UP = '\u001B[A';

interface TimerDriver {
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  fire(ms: number): void;
  pending(): number[];
}

function createTimerDriver(): TimerDriver {
  interface Entry {
    readonly id: number;
    readonly fn: () => void;
    readonly ms: number;
    cleared: boolean;
  }
  const entries: Entry[] = [];
  let nextId = 0;
  return {
    setTimer: (fn, ms) => {
      nextId += 1;
      entries.push({ id: nextId, fn, ms, cleared: false });
      return nextId;
    },
    clearTimer: (handle) => {
      const entry = entries.find((candidate) => candidate.id === handle);
      if (entry !== undefined) entry.cleared = true;
    },
    fire: (ms) => {
      for (const entry of entries.splice(0)) {
        if (!entry.cleared && entry.ms === ms) entry.fn();
      }
    },
    pending: () => entries.filter((entry) => !entry.cleared).map((entry) => entry.ms),
  };
}

interface Harness {
  readonly controller: SurveyController;
  readonly host: SurveyHost;
  readonly container: GutterContainer;
  readonly timers: TimerDriver;
  readonly clock: { mono: number; wall: number };
  elapse(ms: number): void;
  readonly track: ReturnType<typeof vi.fn>;
  readonly editor: {
    inputMode: 'prompt' | 'bash';
    autocompleteActive: boolean;
    getText(): string;
    setText(text: string): void;
  };
  typeDigit(digit: string): void;
  readonly state: SurveyHost['state'];
  readonly writes: number[];
  readonly randomCalls: () => number;
  flush(): Promise<void>;
  runTurns(count: number): void;
  appear(): void;
  renderSurvey(): string;
}

function createHarness(deps: Partial<SurveyControllerDeps> = {}): Harness {
  const clock = { mono: 0, wall: 1_700_000_000_000 };
  const timers = createTimerDriver();
  const track = vi.fn();
  const writes: number[] = [];
  const container = new GutterContainer(1, 1);
  let editorText = '';
  const editor = {
    inputMode: 'prompt' as 'prompt' | 'bash',
    autocompleteActive: false,
    getText: () => editorText,
    setText: (text: string) => {
      editorText = text;
    },
    hasAutocompleteActivity: () => editor.autocompleteActive,
  };
  const state = {
    surveyContainer: container,
    transcriptEntries: [] as TranscriptEntry[],
    editorReplacementMounted: false,
    activeDialog: null,
    livePane: { mode: 'idle', pendingApproval: null, pendingQuestion: null },
    externalEditorRunning: false,
    tasksBrowser: undefined,
    editor,
    appState: {
      model: 'k2',
      streamingPhase: 'idle',
      isCompacting: false,
      contextTokens: 640,
      cumulativeTokens: 1234,
      permissionMode: 'manual',
      thinkingEffort: 'high',
      disableFeedbackSurvey: false,
    },
    ui: { requestRender: vi.fn() },
  };
  let randomCallCount = 0;
  let appearanceCounter = 0;
  const { random: randomOverride, ...restDeps } = deps;
  const host = {
    state,
    btwPanelController: { isActive: () => false },
    track,
  } as unknown as SurveyHost;
  const controller = new SurveyController(host, {
    monotonicNow: () => clock.mono,
    wallNow: () => clock.wall,
    random: () => {
      randomCallCount += 1;
      return (randomOverride ?? (() => 0))();
    },
    appearanceId: () => {
      appearanceCounter += 1;
      return `appearance-${String(appearanceCounter)}`;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    terminalWidth: () => 120,
    terminalHeight: () => 24,
    configFresh: () => true,
    readGlobalLastShown: async () => undefined,
    writeGlobalLastShown: (wallTime) => {
      writes.push(wallTime);
    },
    ...restDeps,
  });

  const harness: Harness = {
    controller,
    host,
    container,
    timers,
    clock,
    track,
    editor,
    state: state as unknown as SurveyHost['state'],
    writes,
    randomCalls: () => randomCallCount,
    elapse: (ms) => {
      clock.mono += ms;
      timers.fire(ms);
    },
    flush: async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    runTurns: (count) => {
      for (let turn = 1; turn <= count; turn++) {
        controller.notifyTurnStarted(true);
        controller.notifyTurnEnded();
      }
    },
    appear: () => {
      clock.mono += 600_000;
      harness.runTurns(5);
      harness.elapse(2000);
      clock.mono += 600;
    },
    typeDigit: (digit: string) => {
      controller.handlePreInput(digit);
      controller.handleEditorChange(digit);
    },
    renderSurvey: () =>
      container
        .render(120)
        .join('\n')
        .replaceAll(/\u001B\[[0-9;]*m/g, ''),
  };
  return harness;
}

function userEntry(content: string): TranscriptEntry {
  return { id: content, kind: 'user', turnId: undefined, renderMode: 'plain', content };
}

const HARNESS_ENVIRONMENT = {
  current_model: 'k2',
  user_turn_count: 5,
  cumulative_tokens: 1234,
  virtual_context_tokens: 640,
  tool_call_count: 0,
  compaction_count: 0,
  permission_mode: 'manual',
  thinking_effort: 'high',
};

const DEFAULT_SNAPSHOT = {
  config_probability: 0.005,
  config_on_for_models: '*',
  config_min_time_before_feedback_ms: 600_000,
  config_min_user_turns_before_feedback: 5,
  config_min_time_between_feedback_ms: 3_600_000,
  config_min_user_turns_between_feedback: 10,
  config_min_time_between_global_feedback_ms: 100_000_000,
  config_long_context_survey_threshold: 200_000,
  config_long_context_probability: 0.2,
  config_long_context_trigger_mode: 'cumulative',
};

describe('SurveyController gating', () => {
  it('appears once the session clears warmup and reports appeared', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();

    expect(harness.renderSurvey()).toContain('How is Kimi doing this session? (optional)');
    expect(harness.renderSurvey()).toContain('1: Bad');
    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith('feedback_survey', {
      event_type: 'appeared',
      appearance_id: 'appearance-1',
      appearance_index: 1,
      response: undefined,
      ...HARNESS_ENVIRONMENT,
      ...DEFAULT_SNAPSHOT,
    });
    expect(harness.writes).toEqual([1_700_000_000_000]);
  });

  it('stays hidden during warmup and appears once it completes', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 597_999;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('stays hidden without enough user turns', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden when sampled out', async () => {
    const harness = createHarness({ random: () => 0.9 });
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('stays hidden when telemetry is disabled', async () => {
    const harness = createHarness({ telemetryDisabled: () => true });
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden when the user disabled the survey', async () => {
    const harness = createHarness({ feedbackSurveyDisabled: () => true });
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden inside the persisted global cooldown', async () => {
    const harness = createHarness({
      readGlobalLastShown: async () => 1_700_000_000_000 - 1000,
    });
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden while the latest user message opens an ordered list', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.state.transcriptEntries.push(userEntry('1. first item'));
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden while a btw panel is active', async () => {
    const harness = createHarness();
    (harness.host.btwPanelController as { isActive: () => boolean }).isActive = () => true;
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden while an editor replacement is mounted', async () => {
    const harness = createHarness();
    harness.state.editorReplacementMounted = true;
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });

  it('cancels a pending evaluation when a new turn starts', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.controller.notifyTurnStarted(true);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
  });

  it('does not arm the idle evaluation when a cron turn ends on its own', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.controller.notifyTurnStarted(false);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('re-arms the pending evaluation after non-user continuation turns end', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();

    harness.controller.notifyTurnStarted(false);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('keeps one sample per user turn across evaluations', async () => {
    const harness = createHarness({ random: () => 0.9 });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);
    harness.controller.notifyTurnStarted(false);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.randomCalls()).toBe(1);
    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.randomCalls()).toBe(2);
  });

  it('paces the second appearance by time and turns, and bumps appearance_index', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.controller.handlePreInput(ESC);
    expect(harness.container.children).toHaveLength(0);

    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    harness.clock.mono += 3_600_000;
    harness.clock.wall += 100_000_000;
    harness.runTurns(10);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).toHaveBeenLastCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', appearance_index: 2 }),
    );
  });
});

describe('SurveyController long-context arm', () => {
  it('shows the long-context survey over the cumulative threshold without any warmup', async () => {
    const harness = createHarness();
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    expect(harness.renderSurvey()).toContain('How is Kimi doing this session? (optional)');
    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith('long_context_survey', {
      event_type: 'appeared',
      appearance_id: 'appearance-1',
      appearance_index: 1,
      response: undefined,
      current_model: 'k2',
      user_turn_count: 1,
      cumulative_tokens: 250_000,
      virtual_context_tokens: 640,
      tool_call_count: 0,
      compaction_count: 0,
      permission_mode: 'manual',
      thinking_effort: 'high',
      ...DEFAULT_SNAPSHOT,
    });
    expect(harness.writes).toEqual([]);
  });

  it('reports the responded and abandoned states under the long_context_survey name', async () => {
    const responded = createHarness();
    responded.state.appState.cumulativeTokens = 250_000;
    await responded.flush();
    responded.controller.notifyTurnStarted(true);
    responded.controller.notifyTurnEnded();
    responded.elapse(2000);
    responded.clock.mono += 600;

    responded.typeDigit('2');
    responded.elapse(400);
    responded.elapse(3000);
    expect(responded.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({
        event_type: 'responded',
        response: 'fine',
        appearance_id: 'appearance-1',
      }),
    );

    const abandoned = createHarness();
    abandoned.state.appState.cumulativeTokens = 250_000;
    await abandoned.flush();
    abandoned.controller.notifyTurnStarted(true);
    abandoned.controller.notifyTurnEnded();
    abandoned.elapse(2000);
    abandoned.clock.mono += 600;

    abandoned.controller.handleEditorChange('hello');
    expect(abandoned.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'abandoned', appearance_id: 'appearance-1' }),
    );
  });

  it('prefers the long-context survey when the session arm is also eligible', async () => {
    const harness = createHarness();
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.appear();

    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared', appearance_index: 1 }),
    );
  });

  it('compares the cumulative counter by default and ignores the window occupancy', async () => {
    const harness = createHarness();
    harness.state.appState.contextTokens = 500_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('compares the window occupancy when the trigger mode is virtual_context', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_CONFIG,
        long_context_trigger_mode: 'virtual_context',
      }),
    });
    harness.state.appState.contextTokens = 250_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({
        event_type: 'appeared',
        cumulative_tokens: 1234,
        virtual_context_tokens: 250_000,
        config_long_context_trigger_mode: 'virtual_context',
      }),
    );
  });

  it('closes the arm on a non-positive effective threshold and produces no events', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_CONFIG, long_context_survey_threshold: 0 }),
    });
    harness.state.appState.cumulativeTokens = 500_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('leaves the session arm running when the threshold closes the long-context arm', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_CONFIG, long_context_survey_threshold: 0 }),
    });
    harness.state.appState.cumulativeTokens = 500_000;
    await harness.flush();

    harness.appear();

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', config_long_context_survey_threshold: 0 }),
    );
  });

  it('stays hidden when the long-context roll misses, and never rolls again this mount', async () => {
    const harness = createHarness({ random: () => 0.9 });
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.randomCalls()).toBe(2);

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.randomCalls()).toBe(3);
  });

  it('shows at most once per mount even after the first appearance closes', async () => {
    const harness = createHarness();
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );

    harness.clock.mono += 600;
    harness.controller.handlePreInput(ESC);
    expect(harness.container.children).toHaveLength(0);

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    const appeared = harness.track.mock.calls.filter(
      (call) => (call[1] as { event_type?: string }).event_type === 'appeared',
    );
    expect(appeared).toHaveLength(1);
  });

  it('regains its one chance after a session reset', async () => {
    let roll = 0.9;
    const harness = createHarness({ random: () => roll });
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    roll = 0.1;
    harness.controller.reset();
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared', appearance_index: 1 }),
    );
    expect(harness.writes).toEqual([]);
  });

  it('does not spend the roll while an active prompt suppresses the evaluation', async () => {
    const harness = createHarness();
    harness.state.appState.cumulativeTokens = 250_000;
    (harness.host.btwPanelController as { isActive: () => boolean }).isActive = () => true;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.randomCalls()).toBe(1);

    (harness.host.btwPanelController as { isActive: () => boolean }).isActive = () => false;
    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('evaluates only after the mount produced a user turn, even with tokens past the threshold', async () => {
    const harness = createHarness();
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    harness.controller.notifyTurnStarted(false);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('ignores the persisted global cooldown that gates the session arm', async () => {
    const harness = createHarness({
      readGlobalLastShown: async () => 1_700_000_000_000 - 1000,
    });
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);

    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
    expect(harness.writes).toEqual([]);
  });

  it('does not suppress the session arm through the persisted cooldown after a long-context appearance', async () => {
    const harness = createHarness();
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();

    harness.controller.notifyTurnStarted(true);
    harness.controller.notifyTurnEnded();
    harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
    harness.clock.mono += 600;
    harness.controller.handlePreInput(ESC);
    expect(harness.writes).toEqual([]);

    harness.clock.mono += 3_600_000;
    harness.runTurns(10);
    harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
    expect(harness.writes).toEqual([1_700_000_000_000]);
  });
});

describe('SurveyController interaction', () => {
  it('selects a rating after the digit debounce and walks pending → thanks → closed', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    harness.editor.setText('2');
    harness.typeDigit('2');
    harness.typeDigit('2');
    harness.elapse(400);

    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.editor.getText()).toBe('');
    expect(harness.renderSurvey()).toContain('Feedback: Fine · [escape: undo]');

    harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith('feedback_survey', {
      event_type: 'responded',
      appearance_id: 'appearance-1',
      appearance_index: 1,
      response: 'fine',
      ...HARNESS_ENVIRONMENT,
      ...DEFAULT_SNAPSHOT,
    });
    expect(harness.renderSurvey()).toContain('Thanks for your feedback!');

    harness.elapse(5000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending digit selection when the edit continues', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.typeDigit('1');
    harness.controller.handleEditorChange('');
    harness.elapse(400);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('undo cancels the pending report, and a re-choice reports only the final rating', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    harness.typeDigit('1');
    harness.elapse(400);
    expect(harness.controller.handlePreInput(ESC)).toBe(true);
    expect(harness.renderSurvey()).toContain('How is Kimi doing this session? (optional)');
    harness.elapse(3000);
    expect(harness.track).not.toHaveBeenCalled();

    harness.typeDigit('3');
    harness.elapse(400);
    harness.elapse(3000);

    const responses = harness.track.mock.calls.map(
      (call) => (call[1] as { response?: string }).response,
    );
    expect(responses).toEqual(['good']);
    expect(harness.track.mock.calls[0]![1]).toMatchObject({ appearance_id: 'appearance-1' });
  });

  it('Esc dismisses without thanks', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    expect(harness.controller.handlePreInput(ESC)).toBe(true);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'dismissed' }),
    );
    expect(harness.timers.pending()).toHaveLength(0);
  });

  it('digit 0 dismisses without thanks and clears the editor', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.editor.setText('0');
    harness.typeDigit('0');
    harness.elapse(400);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'dismissed' }),
    );
    expect(harness.editor.getText()).toBe('');
    expect(harness.container.children).toHaveLength(0);
  });

  it('abandons on non-option input', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    harness.controller.handleEditorChange('hello');
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('preserves the pre-existing draft snapshot through the editor pre-submit clear', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.editor.setText('2');
    harness.appear();
    harness.track.mockClear();

    harness.controller.handleEditorChange('');
    expect(harness.controller.handleSubmit('2')).toBe(false);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('treats a digit retyped after deleting the snapshot draft as fresh input', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.editor.setText('2');
    harness.appear();

    harness.controller.handleEditorChange('');
    harness.controller.handlePreInput('2');
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');
    expect(harness.timers.pending()).toHaveLength(1);
  });

  it('lets a pre-existing digit draft submit instead of treating it as a rating', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.editor.setText('2');
    harness.appear();
    harness.track.mockClear();

    harness.controller.handleEditorChange('2');
    harness.elapse(400);
    expect(harness.track).not.toHaveBeenCalled();

    expect(harness.controller.handleSubmit('2')).toBe(false);
    expect(harness.editor.getText()).toBe('2');
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('intercepts a lone digit submit as a selection instead of sending', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.editor.setText('1');

    expect(harness.controller.handleSubmit('1')).toBe(true);
    harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
    );
    expect(harness.editor.getText()).toBe('');
  });

  it('lets other submissions through and abandons the survey', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();

    expect(harness.controller.handleSubmit('hello')).toBe(false);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('ignores all input during the mount protection window', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);

    expect(harness.controller.handlePreInput('1')).toBe(false);
    harness.editor.setText('1');
    harness.controller.handleEditorChange('1');
    expect(harness.timers.pending()).toHaveLength(0);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
    expect(harness.controller.handleSubmit('1')).toBe(false);

    harness.clock.mono += 600;
    harness.typeDigit('1');
    harness.elapse(400);
    harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
    );
  });

  it('abandons when a yank injects a lone digit during the mount window', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);
    harness.track.mockClear();

    expect(harness.controller.handlePreInput('\u0019')).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('abandons when history recall injects a digit during the mount window', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);
    harness.track.mockClear();

    expect(harness.controller.handlePreInput(CSI_UP)).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('moves the hover with arrow keys and confirms with Enter', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();

    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(true);
    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(true);
    expect(harness.controller.handleSubmit('')).toBe(true);
    harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'fine' }),
    );
  });

  it('wraps the hover backwards from nothing to Dismiss', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();

    expect(harness.controller.handlePreInput(CSI_LEFT)).toBe(true);
    expect(harness.controller.handleSubmit('')).toBe(true);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'dismissed' }),
    );
  });

  it('abandons instead of rating when history recall replaces a draft at column zero', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.editor.setText('draft');
    harness.track.mockClear();

    expect(harness.controller.handlePreInput(CSI_UP)).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('debounces a digit that arrives as a CSI-u sequence', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();

    expect(harness.controller.handlePreInput('\u001B[49u')).toBe(false);
    harness.editor.setText('1');
    harness.controller.handleEditorChange('1');
    expect(harness.timers.pending()).toHaveLength(1);
    harness.elapse(400);
    harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
    );
  });

  it('debounces a typed digit even right after an Up cursor move', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.editor.setText('draft');

    expect(harness.controller.handlePreInput(CSI_UP)).toBe(false);
    expect(harness.controller.handlePreInput('2')).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');
    expect(harness.timers.pending()).toHaveLength(1);
    harness.elapse(400);
    harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'fine' }),
    );
  });

  it('abandons instead of rating when history recall injects a lone digit', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    expect(harness.controller.handlePreInput(CSI_UP)).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
    harness.elapse(400);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('abandons instead of rating when a kill-ring yank injects a lone digit', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    expect(harness.controller.handlePreInput('\u0019')).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('abandons instead of rating when a paste injects a lone digit', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    expect(harness.controller.handlePreInput('\u001B[200~2\u001B[201~')).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
    harness.elapse(400);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('lets arrow keys through to the editor when a draft exists', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.editor.setText('draft');

    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(false);
    expect(harness.controller.handlePreInput(CSI_LEFT)).toBe(false);
    expect(harness.controller.handleSubmit('')).toBe(false);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('clears the hover when the survey closes so a later appearance starts clean', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(true);
    harness.controller.handlePreInput(ESC);
    expect(harness.container.children).toHaveLength(0);

    harness.clock.mono += 3_600_000;
    harness.clock.wall += 100_000_000;
    harness.runTurns(10);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);

    harness.track.mockClear();
    expect(harness.controller.handleSubmit('')).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('reports the settled rating with the turn count of the turn it was made in', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.typeDigit('1');
    harness.elapse(400);
    harness.track.mockClear();

    harness.controller.notifyTurnStarted(true);

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', user_turn_count: 5 }),
    );
  });

  it('settles the pending rating when a turn starts inside the undo window', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.typeDigit('1');
    harness.elapse(400);
    harness.track.mockClear();

    harness.controller.notifyTurnStarted(true);

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
    );
    expect(harness.timers.pending()).toHaveLength(0);
  });

  it('closes silently when a turn starts while open', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    harness.controller.notifyTurnStarted(true);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('closes silently on a gate flip (editor replacement) without reporting', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    harness.controller.closeSilently();
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('treats bash-mode input as non-option input', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.editor.inputMode = 'bash';

    harness.typeDigit('1');
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('sweeps the survey away as abandoned when the editor enters bash mode', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    harness.editor.inputMode = 'bash';
    harness.controller.notifyInputModeChanged('bash');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
  });

  it('does not open while the external editor is running, on either arm', async () => {
    const harness = createHarness();
    harness.state.appState.cumulativeTokens = 250_000;
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.state.externalEditorRunning = true;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.state.externalEditorRunning = false;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('does not open while the tasks browser takeover is active', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.state.tasksBrowser = {} as never;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.state.tasksBrowser = undefined;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('does not select a hovered option with Enter after the terminal narrows', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    harness.appear();
    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(true);
    harness.track.mockClear();

    width = 8;
    expect(harness.controller.handleSubmit('')).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('does not fire a pending digit selection after the terminal narrows', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    harness.appear();
    harness.editor.setText('2');
    harness.typeDigit('2');
    harness.track.mockClear();

    width = 8;
    harness.elapse(400);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.editor.getText()).toBe('2');
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('lets Escape undo a pending rating even after the terminal narrows', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    harness.appear();
    harness.typeDigit('2');
    harness.elapse(400);
    harness.track.mockClear();

    width = 8;
    expect(harness.controller.handlePreInput(ESC)).toBe(true);
    harness.elapse(3000);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.renderSurvey()).toContain('How is Kimi doing this session? (optional)');
  });

  it('does not open when the terminal is shorter than the survey needs', async () => {
    let height = 24;
    const harness = createHarness({ terminalHeight: () => height });
    await harness.flush();
    harness.clock.mono += 600_000;
    height = 7;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    height = 8;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('requires more height when a narrow terminal wraps the survey title', async () => {
    let height = 24;
    const harness = createHarness({ terminalWidth: () => 14, terminalHeight: () => height });
    await harness.flush();
    harness.clock.mono += 600_000;
    height = 14;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    height = 15;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('counts word-wrapped title rows instead of dividing characters', async () => {
    let height = 24;
    const harness = createHarness({ terminalWidth: () => 18, terminalHeight: () => height });
    await harness.flush();
    harness.clock.mono += 600_000;
    height = 13;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    height = 14;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('passes keys through when the terminal shrinks in height while open', async () => {
    let height = 24;
    const harness = createHarness({ terminalHeight: () => height });
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    height = 6;
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('does not open when the terminal is narrower than the option legend', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    harness.clock.mono += 600_000;
    width = 13;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    width = 14;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('passes keys through when the terminal is narrowed below the legend width while open', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    harness.appear();
    harness.track.mockClear();

    width = 8;
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('does not open while autocomplete is active, and Esc passes through to it', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.editor.autocompleteActive = true;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.editor.autocompleteActive = false;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);

    harness.editor.autocompleteActive = true;
    harness.track.mockClear();
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('does not open while the editor is in bash mode', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.editor.inputMode = 'bash';
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.editor.inputMode = 'prompt';
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('settles and closes a pending rating when the editor enters bash mode', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.typeDigit('2');
    harness.elapse(400);
    harness.track.mockClear();

    harness.editor.inputMode = 'bash';
    harness.controller.notifyInputModeChanged('bash');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'fine' }),
    );
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
  });

  it('closes the thanks state silently when the editor enters bash mode', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.typeDigit('2');
    harness.elapse(400);
    harness.elapse(3000);
    expect(harness.renderSurvey()).toContain('Thanks for your feedback!');
    harness.track.mockClear();

    harness.editor.inputMode = 'bash';
    harness.controller.notifyInputModeChanged('bash');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
  });

  it('defers evaluation until the persisted cooldown read settles, then honors it', async () => {
    let settleRead!: () => void;
    const harness = createHarness({
      readGlobalLastShown: () =>
        new Promise<number | undefined>((resolve) => {
          settleRead = () => {
            resolve(1_700_000_000_000);
          };
        }),
    });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    settleRead();
    await harness.flush();
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('keeps the just-written global cooldown across a reset', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    expect(harness.writes).toEqual([1_700_000_000_000]);
    harness.track.mockClear();

    harness.controller.reset();
    await harness.flush();

    harness.clock.wall += 1;
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('takes the newer of the in-memory and reloaded cooldown timestamps', async () => {
    let diskValue: number | undefined = 1_600_000_000_000;
    const harness = createHarness({ readGlobalLastShown: async () => diskValue });
    await harness.flush();
    harness.appear();
    expect(harness.writes).toEqual([1_700_000_000_000]);
    harness.track.mockClear();

    diskValue = 1_650_000_000_000;
    harness.controller.reset();
    await harness.flush();

    harness.clock.wall += 1;
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('resets in-session pacing on session reset', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.controller.reset();
    await harness.flush();

    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden when the appState mirror disables the survey', async () => {
    const harness = createHarness();
    harness.state.appState.disableFeedbackSurvey = true;
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });
});

describe('SurveyController event payload', () => {
  it('reports the live session statistics and the current model', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.state.appState.model = 'k3';
    harness.clock.mono += 600_000;
    for (let turn = 1; turn <= 5; turn++) {
      harness.controller.notifyTurnStarted(true);
      harness.controller.notifyToolCallStarted();
      harness.controller.notifyToolCallStarted();
      harness.controller.notifyTurnEnded();
    }
    harness.controller.notifyToolCallStarted();
    harness.elapse(2000);

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({
        current_model: 'k3',
        user_turn_count: 5,
        cumulative_tokens: 1234,
        virtual_context_tokens: 640,
        tool_call_count: 11,
        permission_mode: 'manual',
      }),
    );
  });

  it('counts finished compactions since mount and resets on remount', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.controller.notifyCompactionFinished();
    harness.controller.notifyCompactionFinished();
    harness.appear();
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ compaction_count: 2, thinking_effort: 'high' }),
    );

    harness.controller.reset();
    await harness.flush();
    harness.clock.wall += 100_000_000;
    harness.appear();
    expect(harness.track).toHaveBeenLastCalledWith(
      'feedback_survey',
      expect.objectContaining({ compaction_count: 0 }),
    );
  });

  it('snapshots the config that produced the appearance, not a later refresh', async () => {
    let cloudConfig = { ...DEFAULT_SURVEY_POPUP_CONFIG, probability: 0.5 };
    const harness = createHarness({ config: () => cloudConfig });
    await harness.flush();
    harness.appear();
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', config_probability: 0.5 }),
    );

    cloudConfig = { ...cloudConfig, probability: 0.9 };
    harness.typeDigit('1');
    harness.elapse(400);
    harness.elapse(3000);
    expect(harness.track).toHaveBeenLastCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', config_probability: 0.5 }),
    );
  });

  it('cancels the pending digit selection when a cursor key passes through to the draft', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.appear();
    harness.editor.setText('2');
    harness.typeDigit('2');

    expect(harness.controller.handlePreInput(CSI_LEFT)).toBe(false);
    harness.elapse(400);
    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.editor.getText()).toBe('2');
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('keeps deferring while a region-change refresh is still in flight', async () => {
    let region = 'region-a';
    let settle!: () => void;
    let first = true;
    const harness = createHarness({
      configRegion: () => region,
      refreshConfig: () => {
        if (first) {
          first = false;
          return undefined;
        }
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);

    region = 'region-b';
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    settle();
    await harness.flush();
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('defers evaluation until the startup refresh settles', async () => {
    let settle!: () => void;
    const harness = createHarness({
      refreshConfig: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    settle();
    await harness.flush();
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('refreshes and defers when the config cache has gone stale', async () => {
    let fresh = true;
    const refreshConfig = vi.fn(() => {
      fresh = true;
    });
    const harness = createHarness({ configFresh: () => fresh, refreshConfig });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    expect(harness.container.children).toHaveLength(0);

    fresh = false;
    harness.clock.mono += 3_600_000;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
    expect(harness.container.children).toHaveLength(0);

    await harness.flush();
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('defers the evaluation that triggers a refresh so a stale policy cannot open the survey', async () => {
    let region = 'region-a';
    let config = { ...DEFAULT_SURVEY_POPUP_CONFIG, probability: 1 };
    const refreshConfig = vi.fn(() => {
      config = { ...config, probability: 0 };
    });
    const harness = createHarness({
      configRegion: () => region,
      config: () => config,
      refreshConfig,
      random: () => 0.9,
    });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);

    region = 'region-b';
    harness.runTurns(1);
    harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('evaluates with the refreshed policy on the next turn after the deferred evaluation', async () => {
    let region = 'region-a';
    let config = { ...DEFAULT_SURVEY_POPUP_CONFIG, probability: 1, on_for_models: ['other-model'] };
    const refreshConfig = vi.fn(() => {
      config = { ...config, on_for_models: ['*'] };
    });
    const harness = createHarness({
      configRegion: () => region,
      config: () => config,
      refreshConfig,
    });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);

    region = 'region-b';
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    await harness.flush();
    harness.runTurns(1);
    harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', config_on_for_models: '*' }),
    );
  });

  it('re-refreshes the cloud config when the region changes', async () => {
    let region = 'region-a';
    const refreshConfig = vi.fn();
    const harness = createHarness({ refreshConfig, configRegion: () => region });
    await harness.flush();
    expect(refreshConfig).toHaveBeenCalledTimes(1);

    region = 'region-b';
    harness.runTurns(1);
    harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
  });

  it('re-refreshes the cloud config once the previous refresh is over an hour old', async () => {
    const refreshConfig = vi.fn();
    const harness = createHarness({ refreshConfig });
    await harness.flush();
    expect(refreshConfig).toHaveBeenCalledTimes(1);

    harness.clock.mono += 3_597_000;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(1);

    harness.clock.mono += 2_000;
    harness.runTurns(1);
    harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
  });

  it('applies the cloud model gate at evaluation time', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_CONFIG, on_for_models: ['other-model'] }),
    });
    await harness.flush();
    harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });
});

describe('SurveyController cloud config refresh', () => {
  it('fires the injected refresh once at mount and not on session reset', async () => {
    const refreshConfig = vi.fn();
    const harness = createHarness({ refreshConfig });
    await harness.flush();
    expect(refreshConfig).toHaveBeenCalledTimes(1);

    harness.controller.reset();
    expect(refreshConfig).toHaveBeenCalledTimes(1);
  });

  it('resolves the access token before refreshing the named config', async () => {
    mocks.getSurveyPopupConfig.mockClear();
    const harness = createHarness({ accessToken: async () => 'tok' });
    await harness.flush();
    expect(mocks.getSurveyPopupConfig).toHaveBeenCalledWith({
      accessToken: 'tok',
    });
  });

  it('refreshes anonymously when no token is cached', async () => {
    mocks.getSurveyPopupConfig.mockClear();
    const harness = createHarness({ accessToken: async () => undefined });
    await harness.flush();
    expect(mocks.getSurveyPopupConfig).toHaveBeenCalledWith({
      accessToken: undefined,
    });
  });

  it.each([
    [
      'rejects',
      async (): Promise<string | undefined> => {
        throw new Error('no facade');
      },
    ],
    [
      'throws synchronously',
      () => {
        throw new Error('no facade');
      },
    ],
  ])('skips the fetch when the token provider %s', async (_kind, accessToken) => {
    mocks.getSurveyPopupConfig.mockClear();
    const harness = createHarness({
      accessToken: accessToken as () => Promise<string | undefined>,
    });
    await harness.flush();
    expect(mocks.getSurveyPopupConfig).not.toHaveBeenCalled();
  });

  it('does not fetch without a token provider', async () => {
    mocks.getSurveyPopupConfig.mockClear();
    const harness = createHarness();
    await harness.flush();
    expect(mocks.getSurveyPopupConfig).not.toHaveBeenCalled();
  });
});
