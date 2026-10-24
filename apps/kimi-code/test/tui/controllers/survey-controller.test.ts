import type { TurnStartedEvent } from '@moonshot-ai/kimi-code-sdk';
import {
  DEFAULT_SURVEY_POPUP_PAYLOAD,
  SurveyPopupConfigFeed,
  type SurveyPopupPayload,
} from '@moonshot-ai/kimi-code-product/session-rating/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import {
  SurveyController,
  type SurveyControllerDeps,
  type SurveyHost,
} from '#/tui/controllers/survey-controller';
import type { TranscriptEntry } from '#/tui/types';

const USER_ORIGIN: TurnStartedEvent['origin'] = { kind: 'user' };
const SYSTEM_ORIGIN: TurnStartedEvent['origin'] = { kind: 'system_trigger', name: 'cron' };

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
  elapse(ms: number): Promise<void>;
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
  appear(): Promise<void>;
  renderSurvey(): string;
}

interface HarnessOptions extends Partial<SurveyControllerDeps> {
  readonly config?: () => SurveyPopupPayload;
  readonly refreshConfig?: () => unknown;
}

function createHarness(deps: HarnessOptions = {}): Harness {
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
      availableModels: {},
      availableProviders: {},
    },
    ui: { requestRender: vi.fn() },
  };
  let randomCallCount = 0;
  let appearanceCounter = 0;
  const { random: randomOverride, config, refreshConfig, ...restDeps } = deps;
  const host = {
    state,
    btwPanelController: { isActive: () => false },
    track,
  } as unknown as SurveyHost;
  const controller = new SurveyController(host, {
    configFeed: new SurveyPopupConfigFeed({
      peek: config ?? (() => DEFAULT_SURVEY_POPUP_PAYLOAD),
      isFresh: () => true,
      region: () => 'region-a',
      refresh: refreshConfig,
      now: () => clock.mono,
    }),
    cooldown: {
      read: () => writes.at(-1),
      write: (wallTime) => {
        writes.push(wallTime);
      },
    },
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
    elapse: async (ms) => {
      clock.mono += ms;
      timers.fire(ms);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    flush: async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    runTurns: (count) => {
      for (let turn = 1; turn <= count; turn++) {
        controller.notifyTurnStarted(USER_ORIGIN);
        controller.notifyTurnEnded();
      }
    },
    appear: async () => {
      clock.mono += 600_000;
      harness.runTurns(5);
      await harness.elapse(2000);
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
  subagent_count: 0,
  swarm_run_count: 0,
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
  config_long_context_trigger_mode: 'virtual_context',
};

function trackedEvent(harness: Harness, eventType: string): Record<string, unknown> {
  const call = harness.track.mock.calls.find(
    (candidate) => (candidate[1] as Record<string, unknown>)['event_type'] === eventType,
  );
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

describe('SurveyController engine wiring', () => {
  it('appears once the session clears warmup and reports appeared', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();

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
});

describe('SurveyController UI veto', () => {
  it('stays hidden while the latest user message opens an ordered list', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.state.transcriptEntries.push(userEntry('1. first item'));
    await harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });
  it('stays hidden while a btw panel is active', async () => {
    const harness = createHarness();
    (harness.host.btwPanelController as { isActive: () => boolean }).isActive = () => true;
    await harness.flush();
    await harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });
  it('stays hidden while an editor replacement is mounted', async () => {
    const harness = createHarness();
    harness.state.editorReplacementMounted = true;
    await harness.flush();
    await harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });
  it('does not spend the roll while an active prompt suppresses the evaluation', async () => {
    const harness = createHarness();
    harness.state.appState.contextTokens = 250_000;
    (harness.host.btwPanelController as { isActive: () => boolean }).isActive = () => true;
    await harness.flush();

    harness.controller.notifyTurnStarted(USER_ORIGIN);
    harness.controller.notifyTurnEnded();
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.randomCalls()).toBe(0);

    (harness.host.btwPanelController as { isActive: () => boolean }).isActive = () => false;
    harness.controller.notifyTurnStarted(USER_ORIGIN);
    harness.controller.notifyTurnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });
});

describe('SurveyController model route', () => {
  const MANAGED_BASE_URL = 'https://api.kimi.com/coding/v1';
  const GATEWAY_BASE_URL = 'https://gateway.example.com/coding/v1';
  const savedBaseUrl = process.env['KIMI_CODE_BASE_URL'];

  beforeEach(() => {
    delete process.env['KIMI_CODE_BASE_URL'];
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) {
      delete process.env['KIMI_CODE_BASE_URL'];
    } else {
      process.env['KIMI_CODE_BASE_URL'] = savedBaseUrl;
    }
  });

  function useModel(
    harness: Harness,
    options: { entryBaseUrl?: string; providerBaseUrl?: string } = {},
  ): void {
    harness.state.appState.model = 'main';
    harness.state.appState.availableModels = {
      main: {
        provider: 'managed:kimi-code',
        model: 'k3',
        maxContextSize: 256_000,
        baseUrl: options.entryBaseUrl,
      },
    };
    harness.state.appState.availableProviders = {
      'managed:kimi-code': { type: 'kimi', baseUrl: options.providerBaseUrl ?? MANAGED_BASE_URL },
    };
  }

  it('prefers the entry baseUrl over the provider baseUrl when the entry is managed', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, on_for_models: ['k3'] }),
    });
    useModel(harness, { entryBaseUrl: MANAGED_BASE_URL, providerBaseUrl: GATEWAY_BASE_URL });
    await harness.flush();
    await harness.appear();

    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', kfc_model_id: 'k3' }),
    );
  });
  it('prefers the entry baseUrl over the provider baseUrl when the entry is self-hosted', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, on_for_models: ['k3'] }),
    });
    useModel(harness, { entryBaseUrl: GATEWAY_BASE_URL, providerBaseUrl: MANAGED_BASE_URL });
    await harness.flush();
    await harness.appear();

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
  });
});

describe('SurveyController config feed', () => {
  it('fires the injected refresh once at mount and not on session reset', async () => {
    const refreshConfig = vi.fn();
    const harness = createHarness({ refreshConfig });
    await harness.flush();
    expect(refreshConfig).toHaveBeenCalledTimes(1);

    harness.controller.reset();
    expect(refreshConfig).toHaveBeenCalledTimes(1);
  });
});

describe('SurveyController interaction', () => {
  it('selects a rating after the digit debounce and walks pending → thanks → closed', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.track.mockClear();

    harness.editor.setText('2');
    harness.typeDigit('2');
    harness.typeDigit('2');
    await harness.elapse(400);

    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.editor.getText()).toBe('');
    expect(harness.renderSurvey()).toContain('Feedback: Fine · [escape: undo]');

    await harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith('feedback_survey', {
      event_type: 'responded',
      appearance_id: 'appearance-1',
      appearance_index: 1,
      response: 'fine',
      ...HARNESS_ENVIRONMENT,
      ...DEFAULT_SNAPSHOT,
    });
    expect(harness.renderSurvey()).toContain('Thanks for your feedback!');

    await harness.elapse(5000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending digit selection when the edit continues', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.typeDigit('1');
    harness.controller.handleEditorChange('');
    await harness.elapse(400);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('undo cancels the pending report, and a re-choice reports only the final rating', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.track.mockClear();

    harness.typeDigit('1');
    await harness.elapse(400);
    expect(harness.controller.handlePreInput(ESC)).toBe(true);
    expect(harness.renderSurvey()).toContain('How is Kimi doing this session? (optional)');
    await harness.elapse(3000);
    expect(harness.track).not.toHaveBeenCalled();

    harness.typeDigit('3');
    await harness.elapse(400);
    await harness.elapse(3000);

    const responses = harness.track.mock.calls.map(
      (call) => (call[1] as { response?: string }).response,
    );
    expect(responses).toEqual(['good']);
    expect(harness.track.mock.calls[0]![1]).toMatchObject({ appearance_id: 'appearance-1' });
  });

  it('Esc dismisses without thanks', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
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
    await harness.appear();
    harness.editor.setText('0');
    harness.typeDigit('0');
    await harness.elapse(400);
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
    await harness.appear();
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
    await harness.appear();
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
    await harness.appear();

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
    await harness.appear();
    harness.track.mockClear();

    harness.controller.handleEditorChange('2');
    await harness.elapse(400);
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
    await harness.appear();
    harness.editor.setText('1');

    expect(harness.controller.handleSubmit('1')).toBe(true);
    await harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
    );
    expect(harness.editor.getText()).toBe('');
  });

  it('lets other submissions through and abandons the survey', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();

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
    await harness.elapse(2000);

    expect(harness.controller.handlePreInput('1')).toBe(false);
    harness.editor.setText('1');
    harness.controller.handleEditorChange('1');
    expect(harness.timers.pending()).toHaveLength(0);
    expect(harness.container.children).not.toHaveLength(0);
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
    expect(harness.controller.handleSubmit('1')).toBe(false);

    harness.clock.mono += 600;
    harness.typeDigit('1');
    await harness.elapse(400);
    await harness.elapse(3000);
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
    await harness.elapse(2000);
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
    await harness.elapse(2000);
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
    await harness.appear();

    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(true);
    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(true);
    expect(harness.controller.handleSubmit('')).toBe(true);
    await harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'fine' }),
    );
  });

  it('wraps the hover backwards from nothing to Dismiss', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();

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
    await harness.appear();
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
    await harness.appear();

    expect(harness.controller.handlePreInput('\u001B[49u')).toBe(false);
    harness.editor.setText('1');
    harness.controller.handleEditorChange('1');
    expect(harness.timers.pending()).toHaveLength(1);
    await harness.elapse(400);
    await harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
    );
  });

  it('debounces a typed digit even right after an Up cursor move', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.editor.setText('draft');

    expect(harness.controller.handlePreInput(CSI_UP)).toBe(false);
    expect(harness.controller.handlePreInput('2')).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');
    expect(harness.timers.pending()).toHaveLength(1);
    await harness.elapse(400);
    await harness.elapse(3000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'fine' }),
    );
  });

  it('abandons instead of rating when history recall injects a lone digit', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.track.mockClear();

    expect(harness.controller.handlePreInput(CSI_UP)).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
    await harness.elapse(400);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('abandons instead of rating when a kill-ring yank injects a lone digit', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
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
    await harness.appear();
    harness.track.mockClear();

    expect(harness.controller.handlePreInput('\u001B[200~2\u001B[201~')).toBe(false);
    harness.editor.setText('2');
    harness.controller.handleEditorChange('2');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
    await harness.elapse(400);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('lets arrow keys through to the editor when a draft exists', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.editor.setText('draft');

    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(false);
    expect(harness.controller.handlePreInput(CSI_LEFT)).toBe(false);
    expect(harness.controller.handleSubmit('')).toBe(false);
    expect(harness.track).toHaveBeenCalledTimes(1);
  });

  it('clears the hover when the survey closes so a later appearance starts clean', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    expect(harness.controller.handlePreInput(CSI_RIGHT)).toBe(true);
    harness.controller.handlePreInput(ESC);
    expect(harness.container.children).toHaveLength(0);

    harness.clock.mono += 3_600_000;
    harness.clock.wall += 100_000_000;
    harness.runTurns(10);
    await harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);

    harness.track.mockClear();
    expect(harness.controller.handleSubmit('')).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('reports the settled rating with the turn count of the turn it was made in', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.typeDigit('1');
    await harness.elapse(400);
    harness.track.mockClear();

    harness.controller.notifyTurnStarted(USER_ORIGIN);

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', user_turn_count: 5 }),
    );
  });

  it('settles the pending rating when a turn starts inside the undo window', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.typeDigit('1');
    await harness.elapse(400);
    harness.track.mockClear();

    harness.controller.notifyTurnStarted(USER_ORIGIN);

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
    );
    expect(harness.timers.pending()).toHaveLength(0);
  });

  it('reports abandoned when a turn starts while open', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.track.mockClear();

    harness.controller.notifyTurnStarted(USER_ORIGIN);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('reports abandoned when displaced by an editor replacement', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.track.mockClear();

    harness.controller.notifyDisplaced();
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('reports the selected rating when displaced while pending', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.typeDigit('2');
    await harness.elapse(400);
    harness.track.mockClear();

    harness.controller.notifyDisplaced();
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'fine' }),
    );
  });

  it('reports abandoned when a session reset arrives while open', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.track.mockClear();

    harness.controller.reset();
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'abandoned' }),
    );
  });

  it('reports the selected rating when a session reset arrives while pending', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.typeDigit('2');
    await harness.elapse(400);
    harness.track.mockClear();

    harness.controller.reset();
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'fine' }),
    );
  });

  it('stays silent when disposed while open', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.track.mockClear();

    harness.controller.dispose();
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('treats bash-mode input as non-option input', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
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
    await harness.appear();
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
    harness.state.appState.contextTokens = 250_000;
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.state.externalEditorRunning = true;
    harness.runTurns(5);
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.state.externalEditorRunning = false;
    harness.runTurns(1);
    await harness.elapse(2000);
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
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.state.tasksBrowser = undefined;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('does not select a hovered option with Enter after the terminal narrows', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    await harness.appear();
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
    await harness.appear();
    harness.editor.setText('2');
    harness.typeDigit('2');
    harness.track.mockClear();

    width = 8;
    await harness.elapse(400);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.editor.getText()).toBe('2');
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('lets Escape undo a pending rating even after the terminal narrows', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    await harness.appear();
    harness.typeDigit('2');
    await harness.elapse(400);
    harness.track.mockClear();

    width = 8;
    expect(harness.controller.handlePreInput(ESC)).toBe(true);
    await harness.elapse(3000);
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
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    height = 8;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('requires more height when a narrow terminal wraps the survey title', async () => {
    let height = 24;
    const harness = createHarness({ terminalWidth: () => 14, terminalHeight: () => height });
    await harness.flush();
    harness.clock.mono += 600_000;
    height = 14;
    harness.runTurns(5);
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    height = 15;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('counts word-wrapped title rows instead of dividing characters', async () => {
    let height = 24;
    const harness = createHarness({ terminalWidth: () => 18, terminalHeight: () => height });
    await harness.flush();
    harness.clock.mono += 600_000;
    height = 13;
    harness.runTurns(5);
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);

    height = 14;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('passes keys through when the terminal shrinks in height while open', async () => {
    let height = 24;
    const harness = createHarness({ terminalHeight: () => height });
    await harness.flush();
    await harness.appear();
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
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    width = 14;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('passes keys through when the terminal is narrowed below the legend width while open', async () => {
    let width = 120;
    const harness = createHarness({ terminalWidth: () => width });
    await harness.flush();
    await harness.appear();
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
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.editor.autocompleteActive = false;
    harness.runTurns(1);
    await harness.elapse(2000);
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
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();

    harness.editor.inputMode = 'prompt';
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.container.children).not.toHaveLength(0);
  });

  it('settles and closes a pending rating when the editor enters bash mode', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.typeDigit('2');
    await harness.elapse(400);
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
    await harness.appear();
    harness.typeDigit('2');
    await harness.elapse(400);
    await harness.elapse(3000);
    expect(harness.renderSurvey()).toContain('Thanks for your feedback!');
    harness.track.mockClear();

    harness.editor.inputMode = 'bash';
    harness.controller.notifyInputModeChanged('bash');

    expect(harness.container.children).toHaveLength(0);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.controller.handlePreInput(ESC)).toBe(false);
  });




  it('resets in-session pacing on session reset', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.controller.reset();
    await harness.flush();

    harness.runTurns(5);
    await harness.elapse(2000);
    expect(harness.container.children).toHaveLength(0);
  });

  it('stays hidden when the appState mirror disables the survey', async () => {
    const harness = createHarness();
    harness.state.appState.disableFeedbackSurvey = true;
    await harness.flush();
    await harness.appear();
    expect(harness.container.children).toHaveLength(0);
  });
    it('cancels the pending digit selection when a cursor key passes through to the draft', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.editor.setText('2');
    harness.typeDigit('2');

    expect(harness.controller.handlePreInput(CSI_LEFT)).toBe(false);
    await harness.elapse(400);
    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.editor.getText()).toBe('2');
    expect(harness.container.children).not.toHaveLength(0);
  });
});
