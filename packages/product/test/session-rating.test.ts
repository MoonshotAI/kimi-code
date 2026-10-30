import type { PromptOrigin } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mountSessionRating,
  type RatingEnvironment,
  type ResumedAgentSeed,
  type SessionFact,
  type SessionRatingMount,
} from '#/session-rating/node/engine';
import type { RatingOffer, RatingReport, RatingResponse } from '#/session-rating/common/types';
import { SessionRatingLedger } from '#/session-rating/node/ledger';
import {
  DEFAULT_SURVEY_POPUP_PAYLOAD,
  type SurveyPopupPayload,
} from '#/session-rating/common/survey-popup-config';
import {
  SurveyPopupConfigFeed,
} from '#/session-rating/node/survey-popup-config-feed';

const USER_ORIGIN: PromptOrigin = { kind: 'user' };
const SYSTEM_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'background-task' };
const MANAGED_BASE_URL = 'https://api.kimi.com/coding/v1';
const GATEWAY_BASE_URL = 'https://gateway.example.com/coding/v1';
const DIGIT_RESPONSES: Record<string, RatingResponse | undefined> = {
  '1': 'bad',
  '2': 'fine',
  '3': 'good',
};

interface Scheduler {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  advance(ms: number): Promise<void>;
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function createScheduler(clock: { mono: number }): Scheduler {
  interface Entry {
    readonly id: number;
    readonly due: number;
    readonly fn: () => void;
    cleared: boolean;
  }
  const entries: Entry[] = [];
  let nextId = 0;
  return {
    setTimer: (fn, ms) => {
      nextId += 1;
      entries.push({ id: nextId, due: clock.mono + ms, fn, cleared: false });
      return nextId;
    },
    clearTimer: (handle) => {
      const entry = entries.find((candidate) => candidate.id === handle);
      if (entry !== undefined) entry.cleared = true;
    },
    advance: async (ms) => {
      const target = clock.mono + ms;
      for (;;) {
        const next = entries
          .filter((entry) => !entry.cleared && entry.due <= target)
          .toSorted((a, b) => a.due - b.due || a.id - b.id)[0];
        if (next === undefined) break;
        next.cleared = true;
        clock.mono = Math.max(clock.mono, next.due);
        next.fn();
        await flushAsync();
      }
      clock.mono = target;
    },
  };
}

type MutableEnvironment = { -readonly [K in keyof RatingEnvironment]: RatingEnvironment[K] };

interface HarnessOptions {
  readonly config?: () => SurveyPopupPayload;
  readonly random?: () => number;
  readonly telemetryDisabled?: () => boolean;
  readonly feedbackSurveyDisabled?: () => boolean;
  readonly readGlobalLastShown?: () => number | undefined;
  readonly writeGlobalLastShown?: (wallTime: number) => void;
  readonly configFresh?: () => boolean;
  readonly configRegion?: () => string;
  readonly refreshConfig?: () => unknown;
  readonly manualEvaluation?: boolean;
}

interface FakeHost {
  turnStarted(user: boolean): void;
  turnEnded(requestId?: string): void;
  toolCallStarted(toolCallId: string, toolName: string): void;
  toolCallEnded(toolCallId: string): void;
  subagentSpawned(fact: Omit<Extract<SessionFact, { kind: 'subagent-spawned' }>, 'kind'>): void;
  compactionFinished(): void;
  seedUserTurnCount(count: number | undefined): void;
  seedResumedAgents(agents: Readonly<Record<string, ResumedAgentSeed>>): void;
  remount(): void;
  displace(): void;
  escape(): void;
  choose(digit: string): void;
}

interface Harness {
  mount: SessionRatingMount;
  readonly host: FakeHost;
  readonly env: MutableEnvironment;
  readonly clock: { mono: number; wall: number };
  readonly track: ReturnType<typeof vi.fn>;
  readonly writes: number[];
  readonly ledger: SessionRatingLedger;
  readonly randomCalls: () => number;
  readonly visible: () => boolean;
  elapse(ms: number): Promise<void>;
  flush(): Promise<void>;
  runTurns(count: number): void;
  appear(): Promise<void>;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = { mono: 0, wall: 1_700_000_000_000 };
  const scheduler = createScheduler(clock);
  const track = vi.fn();
  const writes: number[] = [];
  let offer: RatingOffer | undefined;
  const ledger = new SessionRatingLedger({
    telemetryDisabled: () => options.telemetryDisabled?.() ?? env.telemetryDisabled,
    now: () => clock.mono,
  });
  let randomCallCount = 0;
  let appearanceCounter = 0;
  let idleTimer: unknown;
  const env: MutableEnvironment = {
    sessionId: '',
    currentModel: 'k2',
    model: { modelId: undefined, baseUrl: undefined },
    cumulativeTokens: 1234,
    contextTokens: 640,
    permissionMode: 'manual',
    thinkingEffort: 'high',
    busy: false,
    telemetryDisabled: false,
    ratingDisabled: false,
    historyUserTurnCount: 0,
    resumedAgents: undefined,
  };
  const config = new SurveyPopupConfigFeed({
    peek: options.config ?? (() => DEFAULT_SURVEY_POPUP_PAYLOAD),
    isFresh: options.configFresh ?? (() => true),
    region: options.configRegion ?? (() => 'mainland-cn'),
    refresh: options.refreshConfig,
    now: () => clock.mono,
  });
  const create = (): SessionRatingMount =>
    mountSessionRating({
      environment: () => ({
        ...env,
        telemetryDisabled: options.telemetryDisabled?.() ?? env.telemetryDisabled,
        ratingDisabled: options.feedbackSurveyDisabled?.() ?? env.ratingDisabled,
      }),
      config,
      cooldown: {
        read: options.readGlobalLastShown ?? (() => writes.at(-1)),
        write: (wallTime) => {
          writes.push(wallTime);
          options.writeGlobalLastShown?.(wallTime);
        },
      },
      track: (event, properties, context) => {
        if (context.sessionId.length > 0) {
          track(event, properties, context);
        } else {
          track(event, properties);
        }
      },
      ledger,
      now: () => clock.mono,
      wallNow: () => clock.wall,
      random: () => {
        randomCallCount += 1;
        return (options.random ?? (() => 0))();
      },
      appearanceId: () => {
        appearanceCounter += 1;
        return `appearance-${String(appearanceCounter)}`;
      },
    });
  const report = (build: (appearanceId: string) => RatingReport) => {
    if (offer === undefined) throw new Error('expected a rating offer');
    ledger.report(env.sessionId, build(offer.appearanceId));
    offer = undefined;
  };
  const host: FakeHost = {
    turnStarted: (user) => {
      if (idleTimer !== undefined) scheduler.clearTimer(idleTimer);
      idleTimer = undefined;
      offer = undefined;
      harness.mount.observe({ kind: 'turn-started', origin: user ? USER_ORIGIN : SYSTEM_ORIGIN });
    },
    turnEnded: (requestId) => {
      harness.mount.observe({ kind: 'turn-ended', requestId });
      if (options.manualEvaluation === true) return;
      if (idleTimer !== undefined) scheduler.clearTimer(idleTimer);
      idleTimer = scheduler.setTimer(() => {
        idleTimer = undefined;
        offer = harness.mount.evaluate();
        if (offer !== undefined) ledger.report(env.sessionId, { type: 'shown', appearanceId: offer.appearanceId });
      }, 2000);
    },
    toolCallStarted: (toolCallId, toolName) => {
      harness.mount.observe({ kind: 'tool-call-started', toolCallId, toolName });
    },
    toolCallEnded: (toolCallId) => {
      harness.mount.observe({ kind: 'tool-call-ended', toolCallId });
    },
    subagentSpawned: (fact) => {
      harness.mount.observe({ kind: 'subagent-spawned', ...fact });
    },
    compactionFinished: () => {
      harness.mount.observe({ kind: 'compaction-completed' });
    },
    seedUserTurnCount: (count) => {
      env.historyUserTurnCount = count;
    },
    seedResumedAgents: (agents) => {
      env.resumedAgents = agents;
    },
    remount: () => {
      harness.mount.end();
      offer = undefined;
      if (idleTimer !== undefined) scheduler.clearTimer(idleTimer);
      idleTimer = undefined;
      env.historyUserTurnCount = 0;
      env.resumedAgents = undefined;
      harness.mount = create();
    },
    displace: () => report((appearanceId) => ({ type: 'abandon', appearanceId })),
    escape: () => report((appearanceId) => ({ type: 'respond', appearanceId, response: 'dismissed' })),
    choose: (digit) => report((appearanceId) => ({
      type: 'respond', appearanceId, response: DIGIT_RESPONSES[digit] ?? 'dismissed',
    })),
  };
  const harness: Harness = {
    mount: create(),
    host,
    env,
    clock,
    track,
    writes,
    ledger,
    randomCalls: () => randomCallCount,
    visible: () => offer !== undefined,
    elapse: (ms) => scheduler.advance(ms),
    flush: flushAsync,
    runTurns: (count) => {
      for (let turn = 1; turn <= count; turn++) {
        host.turnStarted(true);
        host.turnEnded();
      }
    },
    appear: async () => {
      clock.mono += 600_000;
      harness.runTurns(5);
      await harness.elapse(2000);
      clock.mono += 600;
    },
  };
  return harness;
}

function useModel(
  harness: Harness,
  options: { model?: string; entryBaseUrl?: string; providerBaseUrl?: string } = {},
): void {
  harness.env.currentModel = 'main';
  harness.env.model = {
    modelId: options.model ?? 'k3',
    baseUrl: options.entryBaseUrl ?? options.providerBaseUrl ?? MANAGED_BASE_URL,
  };
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

function appearedCount(harness: Harness): number {
  return harness.track.mock.calls.filter(
    (call) => (call[1] as { event_type?: string }).event_type === 'appeared',
  ).length;
}

const OPEN_CONFIG: SurveyPopupPayload = {
  ...DEFAULT_SURVEY_POPUP_PAYLOAD,
  probability: 1,
  min_time_before_feedback_ms: 0,
  min_user_turns_before_feedback: 1,
  min_time_between_feedback_ms: 0,
  min_user_turns_between_feedback: 1,
  min_time_between_global_feedback_ms: 0,
};

function manual(options: HarnessOptions = {}): Harness {
  return createHarness({ config: () => OPEN_CONFIG, manualEvaluation: true, ...options });
}

describe('session rating evaluation slot', () => {
  it('accepts a delayed evaluation without recording a display', async () => {
    const harness = manual();
    harness.runTurns(1);
    await harness.elapse(100_000);

    expect(harness.mount.evaluate()).toEqual({ appearanceId: 'appearance-1', survey: 'session' });
    expect(harness.track.mock.calls).toEqual([]);
    expect(harness.writes).toEqual([1_700_000_000_000]);
    expect(harness.mount.evaluate()).toBeUndefined();

    harness.ledger.report('', { type: 'shown', appearanceId: 'appearance-1' });
    expect(trackedEvent(harness, 'appeared')).toMatchObject({ appearance_id: 'appearance-1' });
  });

  it('leaves the two-second presentation delay to the client', () => {
    const harness = manual();
    harness.runTurns(1);
    expect(harness.mount.evaluate()).toEqual({ appearanceId: 'appearance-1', survey: 'session' });
  });

  it('invalidates a vetoed slot on a later non-user turn but allows an early continuation', async () => {
    const harness = manual();
    harness.runTurns(1);
    await harness.elapse(2000);
    harness.host.turnStarted(false);
    harness.host.turnEnded();
    expect(harness.mount.evaluate()).toBeUndefined();

    harness.runTurns(1);
    await harness.elapse(1000);
    harness.host.turnStarted(false);
    expect(harness.mount.evaluate()).toBeUndefined();
    harness.host.turnEnded();
    expect(harness.mount.evaluate()).toEqual({ appearanceId: 'appearance-1', survey: 'session' });
  });

  it('checks the cooldown again for each evaluation', () => {
    let stored: number | undefined = 1_700_000_000_000;
    const harness = manual({
      config: () => ({ ...OPEN_CONFIG, min_time_between_global_feedback_ms: 1000 }),
      readGlobalLastShown: () => stored,
    });
    harness.runTurns(1);
    expect(harness.mount.evaluate()).toBeUndefined();
    stored = undefined;
    harness.clock.wall += 1000;
    harness.runTurns(1);
    expect(harness.mount.evaluate()).toEqual({ appearanceId: 'appearance-1', survey: 'session' });
  });
});

describe('session rating global cooldown', () => {
  it('keeps the just-written global cooldown across a remount', async () => {
    const harness = createHarness();
    await harness.appear();
    expect(harness.writes).toEqual([1_700_000_000_000]);

    harness.host.remount();
    harness.track.mockClear();
    harness.clock.wall += 1;
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('keeps the newer in-memory timestamp when the file holds an older one', async () => {
    let diskValue: number | undefined = 1_600_000_000_000;
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, min_time_between_feedback_ms: 0 }),
      readGlobalLastShown: () => diskValue,
    });
    await harness.appear();
    expect(harness.writes).toEqual([1_700_000_000_000]);
    harness.host.escape();
    harness.track.mockClear();

    diskValue = 1_650_000_000_000;
    harness.clock.wall += 1;
    harness.runTurns(10);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('respects a cooldown another process wrote during the mount', async () => {
    let diskValue: number | undefined;
    const harness = createHarness({ readGlobalLastShown: () => diskValue });
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    diskValue = harness.clock.wall - 1000;
    harness.runTurns(1);
    await harness.elapse(2000);

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });
});

describe('session rating mount end', () => {
  it('does not settle on a new turn or unmount and accepts a delayed report', () => {
    const harness = manual();
    harness.runTurns(1);
    expect(harness.mount.evaluate()).toEqual({ appearanceId: 'appearance-1', survey: 'session' });
    harness.ledger.report('', { type: 'shown', appearanceId: 'appearance-1' });
    harness.runTurns(1);
    harness.mount.end();
    harness.mount.end();
    expect(harness.mount.evaluate()).toBeUndefined();
    expect(harness.track.mock.calls.map((call) => call[1].event_type)).toEqual(['appeared']);

    harness.ledger.report('', { type: 'respond', appearanceId: 'appearance-1', response: 'fine' });
    expect(trackedEvent(harness, 'responded')).toMatchObject({ response: 'fine', user_turn_count: 1 });
  });
});

describe('session rating gating', () => {
  it('reports resumed user turns on the long-context survey without changing warmup', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        long_context_survey_threshold: 500,
        long_context_probability: 1,
      }),
    });
    await harness.flush();
    harness.host.seedUserTurnCount(40);
    harness.runTurns(1);
    await harness.elapse(2000);

    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared', user_turn_count: 41 }),
    );
  });

  it('keeps mount warmup independent of historical user turns', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.host.seedUserTurnCount(40);
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    await harness.elapse(2000);
    expect(harness.track).not.toHaveBeenCalled();

    harness.runTurns(1);
    await harness.elapse(2000);
    expect(trackedEvent(harness, 'appeared')).toMatchObject({ user_turn_count: 45 });
  });

  it('omits the cumulative count when resumed history is unknown', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.host.seedUserTurnCount(undefined);
    await harness.appear();

    expect(JSON.parse(JSON.stringify(trackedEvent(harness, 'appeared')))).not.toHaveProperty(
      'user_turn_count',
    );
  });

  it.each([
    [0, 1],
    [20, 21],
    [undefined, undefined],
  ])('uses the new history base %s after remounting', async (base, expected) => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        min_time_between_global_feedback_ms: 0,
        long_context_survey_threshold: 500,
        long_context_probability: 1,
      }),
    });
    await harness.flush();
    harness.host.seedUserTurnCount(40);
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(trackedEvent(harness, 'appeared')).toMatchObject({ user_turn_count: 41 });

    harness.host.remount();
    harness.host.seedUserTurnCount(base);
    await harness.flush();
    harness.track.mockClear();
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(trackedEvent(harness, 'appeared')).toHaveProperty('user_turn_count', expected);
  });

  it.each(['responded', 'abandoned'])(
    'freezes the cumulative count for the %s lifecycle event',
    async (eventType) => {
      const harness = createHarness();
      await harness.flush();
      harness.host.seedUserTurnCount(40);
      await harness.appear();
      harness.host.seedUserTurnCount(100);
      if (eventType === 'responded') {
        harness.host.choose('3');
        await harness.elapse(3000);
      } else {
        harness.host.displace();
      }

      expect(trackedEvent(harness, 'appeared')).toMatchObject({ user_turn_count: 45 });
      expect(trackedEvent(harness, eventType)).toMatchObject({ user_turn_count: 45 });
    },
  );

  it('appears once the session clears warmup and reports appeared', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(true);
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
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
  });

  it('stays hidden without enough user turns', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
  });

  it('stays hidden when sampled out', async () => {
    const harness = createHarness({ random: () => 0.9 });
    await harness.flush();
    await harness.appear();
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('stays hidden when telemetry is disabled', async () => {
    const harness = createHarness({ telemetryDisabled: () => true });
    await harness.flush();
    await harness.appear();
    expect(harness.visible()).toBe(false);
  });

  it('stays hidden when the user disabled the survey', async () => {
    const harness = createHarness({ feedbackSurveyDisabled: () => true });
    await harness.flush();
    await harness.appear();
    expect(harness.visible()).toBe(false);
  });

  it('stays hidden inside the persisted global cooldown', async () => {
    const harness = createHarness({
      readGlobalLastShown: () => 1_700_000_000_000 - 1000,
    });
    await harness.flush();
    await harness.appear();
    expect(harness.visible()).toBe(false);
  });




  it('cancels a pending evaluation when a new turn starts', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(4);
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    harness.host.turnStarted(true);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
  });

  it('does not arm the idle evaluation when a cron turn ends on its own', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.host.turnStarted(false);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();

    harness.runTurns(5);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
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
    harness.host.turnStarted(true);
    harness.host.turnEnded();

    harness.host.turnStarted(false);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
  });

  it('keeps one sample per user turn across evaluations', async () => {
    const harness = createHarness({ random: () => 0.9 });
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    await harness.elapse(2000);
    harness.host.turnStarted(false);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.randomCalls()).toBe(1);
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.randomCalls()).toBe(2);
  });

  it('paces the second appearance by time and turns, and bumps appearance_index', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();
    harness.host.escape();
    expect(harness.visible()).toBe(false);

    harness.runTurns(5);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    harness.clock.mono += 3_600_000;
    harness.clock.wall += 100_000_000;
    harness.runTurns(10);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenLastCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', appearance_index: 2 }),
    );
  });
});

describe('session rating long-context arm', () => {
  it('shows the long-context survey over the context-window threshold without any warmup', async () => {
    const harness = createHarness();
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith('long_context_survey', {
      event_type: 'appeared',
      appearance_id: 'appearance-1',
      appearance_index: 1,
      response: undefined,
      current_model: 'k2',
      user_turn_count: 1,
      cumulative_tokens: 1234,
      virtual_context_tokens: 250_000,
      tool_call_count: 0,
      compaction_count: 0,
      permission_mode: 'manual',
      thinking_effort: 'high',
      subagent_count: 0,
      swarm_run_count: 0,
      ...DEFAULT_SNAPSHOT,
    });
    expect(harness.writes).toEqual([1_700_000_000_000]);
  });

  it('reports the responded and abandoned states under the long_context_survey name', async () => {
    const responded = createHarness();
    responded.env.contextTokens = 250_000;
    await responded.flush();
    responded.host.turnStarted(true);
    responded.host.turnEnded();
    await responded.elapse(2000);
    responded.clock.mono += 600;

    responded.host.choose('2');
    await responded.elapse(3000);
    expect(responded.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({
        event_type: 'responded',
        response: 'fine',
        appearance_id: 'appearance-1',
      }),
    );

    const abandoned = createHarness();
    abandoned.env.contextTokens = 250_000;
    await abandoned.flush();
    abandoned.host.turnStarted(true);
    abandoned.host.turnEnded();
    await abandoned.elapse(2000);
    abandoned.clock.mono += 600;

    abandoned.host.displace();
    expect(abandoned.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'abandoned', appearance_id: 'appearance-1' }),
    );
  });

  it('prefers the long-context survey when the session arm is also eligible', async () => {
    const harness = createHarness();
    harness.env.contextTokens = 250_000;
    await harness.flush();

    await harness.appear();

    expect(harness.track).toHaveBeenCalledTimes(1);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared', appearance_index: 1 }),
    );
  });

  it('ignores the cumulative counter by default, however large it grows', async () => {
    const harness = createHarness();
    harness.env.cumulativeTokens = 500_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('triggers on the current window by default even when the cumulative counter is tiny', async () => {
    const harness = createHarness();
    harness.env.contextTokens = 250_000;
    harness.env.cumulativeTokens = 100;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({
        event_type: 'appeared',
        cumulative_tokens: 100,
        virtual_context_tokens: 250_000,
        config_long_context_trigger_mode: 'virtual_context',
      }),
    );
  });

  it('compares the cumulative counter when the trigger mode is cumulative', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        long_context_trigger_mode: 'cumulative',
      }),
    });
    harness.env.cumulativeTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({
        event_type: 'appeared',
        cumulative_tokens: 250_000,
        virtual_context_tokens: 640,
        config_long_context_trigger_mode: 'cumulative',
      }),
    );
  });

  it('closes the arm on a non-positive effective threshold and produces no events', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, long_context_survey_threshold: 0 }),
    });
    harness.env.contextTokens = 500_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('leaves the session arm running when the threshold closes the long-context arm', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, long_context_survey_threshold: 0 }),
    });
    harness.env.contextTokens = 500_000;
    await harness.flush();

    await harness.appear();

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', config_long_context_survey_threshold: 0 }),
    );
  });

  it('stays hidden when the long-context roll misses, and never rolls again this mount', async () => {
    const harness = createHarness({ random: () => 0.9 });
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.randomCalls()).toBe(2);

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
    expect(harness.randomCalls()).toBe(3);
  });

  it('shows at most once per mount even after the first appearance closes', async () => {
    const harness = createHarness();
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );

    harness.clock.mono += 600;
    harness.host.escape();
    expect(harness.visible()).toBe(false);

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    const appeared = harness.track.mock.calls.filter(
      (call) => (call[1] as { event_type?: string }).event_type === 'appeared',
    );
    expect(appeared).toHaveLength(1);
  });

  it('regains its one chance after a session reset', async () => {
    let roll = 0.9;
    const harness = createHarness({ random: () => roll });
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    roll = 0.1;
    harness.host.remount();
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared', appearance_index: 1 }),
    );
    expect(harness.writes).toEqual([1_700_000_000_000]);
  });


  it('evaluates only after the mount produced a user turn, even with tokens past the threshold', async () => {
    const harness = createHarness();
    harness.env.contextTokens = 250_000;
    await harness.flush();

    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    harness.host.turnStarted(false);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('honors the shared persisted cooldown without spending the roll', async () => {
    const harness = createHarness({
      readGlobalLastShown: () => 1_700_000_000_000 - 1000,
    });
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();

    harness.clock.wall += 100_000_000;
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
    expect(harness.writes).toEqual([1_700_000_000_000 + 100_000_000]);
  });

  it('writes the shared global cooldown on a long-context appearance', async () => {
    const harness = createHarness();
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
    expect(harness.writes).toEqual([1_700_000_000_000]);
    harness.clock.mono += 600;
    harness.host.escape();
    expect(harness.visible()).toBe(false);
    harness.track.mockClear();

    harness.clock.mono += 3_600_000;
    harness.runTurns(10);
    await harness.elapse(2000);
    expect(harness.track).not.toHaveBeenCalled();

    harness.clock.wall += 100_000_000;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('keeps the long-context arm closed across a remount inside the shared cooldown', async () => {
    let stored: number | undefined;
    const harness = createHarness({
      readGlobalLastShown: () => stored,
      writeGlobalLastShown: (wallTime) => {
        stored = wallTime;
      },
    });
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledTimes(1);

    harness.host.remount();
    await harness.flush();
    harness.track.mockClear();
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).not.toHaveBeenCalled();
  });
});

describe('session rating kfc model gate', () => {
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


  function trackedKfcModelId(harness: Harness): unknown {
    const call = harness.track.mock.calls[0];
    return call === undefined ? undefined : (call[1] as Record<string, unknown>)['kfc_model_id'];
  }

  it('opens on "*" for a kfc user and reports the real model id alongside the alias', async () => {
    const harness = createHarness();
    useModel(harness);
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({
        event_type: 'appeared',
        current_model: 'main',
        kfc_model_id: 'k3',
      }),
    );
  });

  it('opens for a kfc user when the real id is listed', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, on_for_models: ['k2', 'k3'] }),
    });
    useModel(harness);
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', kfc_model_id: 'k3' }),
    );
  });

  it('stays closed for a kfc user whose real id is not listed', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, on_for_models: ['k3-256k'] }),
    });
    useModel(harness);
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('opens on "*" for a self-hosted user but omits the kfc model id', async () => {
    const harness = createHarness();
    useModel(harness, { providerBaseUrl: GATEWAY_BASE_URL });
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', current_model: 'main' }),
    );
    expect(trackedKfcModelId(harness)).toBeUndefined();
  });

  it('stays closed for a self-hosted model that happens to share the listed id', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, on_for_models: ['k3'] }),
    });
    useModel(harness, { providerBaseUrl: GATEWAY_BASE_URL });
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('opens on "*" with a dangling alias and omits the kfc model id', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', current_model: 'k2' }),
    );
    expect(trackedKfcModelId(harness)).toBeUndefined();
  });

  it('stays closed on a concrete list when the alias cannot be resolved', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, on_for_models: ['k2'] }),
    });
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('reports the kfc model id on long-context events as well', async () => {
    const harness = createHarness();
    useModel(harness);
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);

    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({
        event_type: 'appeared',
        current_model: 'main',
        kfc_model_id: 'k3',
      }),
    );
  });


});

describe('session rating model overrides', () => {
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


  it('opens for the targeted model under its override probability when the base samples out', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        probability: 0,
        model_overrides: { k3: { probability: 1 } },
      }),
    });
    useModel(harness);
    await harness.flush();
    await harness.appear();

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', config_probability: 1 }),
    );
  });

  it('keeps the base policy for models without an override entry', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        probability: 0,
        model_overrides: { k3: { probability: 1 } },
      }),
    });
    useModel(harness, { model: 'other-model' });
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('applies the override on the next evaluation after the model switches mid-session', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        probability: 0,
        model_overrides: { k3: { probability: 1 } },
      }),
    });
    await harness.flush();
    await harness.appear();
    expect(harness.visible()).toBe(false);

    useModel(harness);
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', kfc_model_id: 'k3' }),
    );
  });

  it('honors the override global cooldown against the shared persisted clock', async () => {
    const harness = createHarness({
      readGlobalLastShown: () => 1_700_000_000_000 - 1000,
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        model_overrides: { k3: { min_time_between_global_feedback_ms: 0 } },
      }),
    });
    useModel(harness);
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(true);
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({
        event_type: 'appeared',
        config_min_time_between_global_feedback_ms: 0,
      }),
    );
  });

  it('keeps on_for_models as the gate even when an override entry matches', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        on_for_models: ['someone-else'],
        model_overrides: { k3: { probability: 1 } },
      }),
    });
    useModel(harness);
    await harness.flush();
    await harness.appear();

    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('targets the long-context arm per model through the override', async () => {
    const targeted = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        model_overrides: { k3: { long_context_probability: 0 } },
      }),
    });
    useModel(targeted);
    targeted.env.contextTokens = 250_000;
    await targeted.flush();

    targeted.host.turnStarted(true);
    targeted.host.turnEnded();
    await targeted.elapse(2000);
    expect(targeted.visible()).toBe(false);
    expect(targeted.track).not.toHaveBeenCalled();

    const untargeted = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        model_overrides: { k3: { long_context_probability: 0 } },
      }),
    });
    untargeted.env.contextTokens = 250_000;
    await untargeted.flush();

    untargeted.host.turnStarted(true);
    untargeted.host.turnEnded();
    await untargeted.elapse(2000);
    expect(untargeted.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('treats the long-context roll as consumed per model across a mid-session switch', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        model_overrides: { k3: { long_context_probability: 0 } },
      }),
    });
    useModel(harness);
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    useModel(harness, { model: 'other-model' });
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared', kfc_model_id: 'other-model' }),
    );

    useModel(harness);
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(
      harness.track.mock.calls.filter(
        (call) => (call[1] as { event_type?: string }).event_type === 'appeared',
      ),
    ).toHaveLength(1);
  });

  it('closes the long-context arm for the rest of the mount after the first appearance', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        model_overrides: { k3: { long_context_probability: 1 } },
      }),
    });
    useModel(harness);
    harness.env.contextTokens = 250_000;
    await harness.flush();

    const appeared = () =>
      harness.track.mock.calls.filter(
        (call) => (call[1] as { event_type?: string }).event_type === 'appeared',
      ).length;

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(appeared()).toBe(1);
    harness.clock.mono += 600;
    harness.host.escape();

    useModel(harness, { model: 'other-model' });
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(appeared()).toBe(1);

    useModel(harness);
    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(appeared()).toBe(1);
  });

  it('honors the override global cooldown on the long-context arm', async () => {
    const harness = createHarness({
      readGlobalLastShown: () => 1_700_000_000_000 - 1000,
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        model_overrides: { k3: { min_time_between_global_feedback_ms: 0 } },
      }),
    });
    useModel(harness);
    harness.env.contextTokens = 250_000;
    await harness.flush();

    harness.host.turnStarted(true);
    harness.host.turnEnded();
    await harness.elapse(2000);
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('reports the merged effective config in the policy snapshot', async () => {
    const harness = createHarness({
      config: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        model_overrides: { k3: { probability: 0.5, min_user_turns_before_feedback: 1 } },
      }),
    });
    useModel(harness);
    await harness.flush();
    await harness.appear();

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({
        event_type: 'appeared',
        config_probability: 0.5,
        config_min_user_turns_before_feedback: 1,
        config_min_time_before_feedback_ms: 600_000,
      }),
    );
  });
});

describe('session rating event payload', () => {
  it('reports the live session statistics and the current model', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.env.currentModel = 'k3';
    harness.clock.mono += 600_000;
    for (let turn = 1; turn <= 5; turn++) {
      harness.host.turnStarted(true);
      harness.host.toolCallStarted('tc-1', 'Bash');
      harness.host.toolCallStarted('tc-2', 'Bash');
      harness.host.turnEnded();
    }
    harness.host.toolCallStarted('tc-3', 'Bash');
    await harness.elapse(2000);

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
    harness.host.compactionFinished();
    harness.host.compactionFinished();
    await harness.appear();
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ compaction_count: 2, thinking_effort: 'high' }),
    );

    harness.host.remount();
    await harness.flush();
    harness.clock.wall += 100_000_000;
    await harness.appear();
    expect(harness.track).toHaveBeenLastCalledWith(
      'feedback_survey',
      expect.objectContaining({ compaction_count: 0 }),
    );
  });

  it('snapshots the config that produced the appearance, not a later refresh', async () => {
    let cloudConfig = { ...DEFAULT_SURVEY_POPUP_PAYLOAD, probability: 0.5 };
    const harness = createHarness({ config: () => cloudConfig });
    await harness.flush();
    await harness.appear();
    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared', config_probability: 0.5 }),
    );

    cloudConfig = { ...cloudConfig, probability: 0.9 };
    harness.host.choose('1');
    await harness.elapse(3000);
    expect(harness.track).toHaveBeenLastCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', config_probability: 0.5 }),
    );
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
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    settle();
    await harness.flush();
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
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
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();

    settle();
    await harness.flush();
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
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
    expect(harness.visible()).toBe(false);

    fresh = false;
    harness.clock.mono += 3_600_000;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
    expect(harness.visible()).toBe(false);

    await harness.flush();
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
  });

  it('defers the evaluation that triggers a refresh so a stale policy cannot open the survey', async () => {
    let region = 'region-a';
    let config = { ...DEFAULT_SURVEY_POPUP_PAYLOAD, probability: 1 };
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
    await harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();

    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);
    expect(harness.track).not.toHaveBeenCalled();
  });

  it('evaluates with the refreshed policy on the next turn after the deferred evaluation', async () => {
    let region = 'region-a';
    let config = { ...DEFAULT_SURVEY_POPUP_PAYLOAD, probability: 1, on_for_models: ['other-model'] };
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
    await harness.elapse(2000);
    expect(harness.visible()).toBe(false);

    await harness.flush();
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(harness.visible()).toBe(true);
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
    await harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
  });

  it('re-refreshes the cloud config once the previous refresh is over an hour old', async () => {
    const refreshConfig = vi.fn();
    const harness = createHarness({ refreshConfig });
    await harness.flush();
    expect(refreshConfig).toHaveBeenCalledTimes(1);

    harness.clock.mono += 3_597_000;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(1);

    harness.clock.mono += 2_000;
    harness.runTurns(1);
    await harness.elapse(2000);
    expect(refreshConfig).toHaveBeenCalledTimes(2);
  });

  it('applies the cloud model gate at evaluation time', async () => {
    const harness = createHarness({
      config: () => ({ ...DEFAULT_SURVEY_POPUP_PAYLOAD, on_for_models: ['other-model'] }),
    });
    await harness.flush();
    await harness.appear();
    expect(harness.visible()).toBe(false);
  });
});

describe('session rating appearance snapshot', () => {
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



  function runUserTurns(harness: Harness, traces: readonly (string | undefined)[]): void {
    for (const trace of traces) {
      harness.host.turnStarted(true);
      harness.host.turnEnded(trace);
    }
  }

  it('reports the triggering turn trace id on every lifecycle event', async () => {
    const harness = createHarness();
    useModel(harness);
    await harness.flush();
    harness.clock.mono += 600_000;
    runUserTurns(harness, ['trace-1', 'trace-2', 'trace-3', 'trace-4', 'trace-final']);
    await harness.elapse(2000);
    harness.clock.mono += 600;

    expect(trackedEvent(harness, 'appeared')).toMatchObject({
      kfc_model_id: 'k3',
      kfc_trace_id: 'trace-final',
    });

    harness.host.choose('3');
    await harness.elapse(3000);

    expect(trackedEvent(harness, 'responded')).toMatchObject({
      response: 'good',
      kfc_model_id: 'k3',
      kfc_trace_id: 'trace-final',
    });
  });

  it('keeps the environment frozen at open across the lifecycle events', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();

    harness.env.currentModel = 'k2-after';
    harness.env.cumulativeTokens = 999_999;
    harness.host.toolCallStarted('tc-late', 'Bash');

    harness.host.choose('2');
    await harness.elapse(3000);

    const appeared = trackedEvent(harness, 'appeared');
    const responded = trackedEvent(harness, 'responded');
    for (const event of [appeared, responded]) {
      expect(event).toMatchObject({
        current_model: 'k2',
        cumulative_tokens: 1234,
        virtual_context_tokens: 640,
        user_turn_count: 5,
        tool_call_count: 0,
      });
    }
  });

  it('omits kfc_trace_id for a non-kfc model even when a trace id is pending', async () => {
    const harness = createHarness();
    useModel(harness, { providerBaseUrl: GATEWAY_BASE_URL });
    await harness.flush();
    harness.clock.mono += 600_000;
    runUserTurns(harness, [undefined, undefined, undefined, undefined, 'trace-gateway']);
    await harness.elapse(2000);

    const appeared = trackedEvent(harness, 'appeared');
    expect(appeared['kfc_model_id']).toBeUndefined();
    expect(appeared['kfc_trace_id']).toBeUndefined();
  });

  it('omits kfc_trace_id when the triggering turn carried no trace id', async () => {
    const harness = createHarness();
    useModel(harness);
    await harness.flush();
    await harness.appear();

    const appeared = trackedEvent(harness, 'appeared');
    expect(appeared['kfc_model_id']).toBe('k3');
    expect(appeared['kfc_trace_id']).toBeUndefined();
  });

  it('carries kfc_trace_id under the long_context_survey name', async () => {
    const harness = createHarness();
    useModel(harness);
    harness.env.contextTokens = 250_000;
    await harness.flush();
    harness.host.turnStarted(true);
    harness.host.turnEnded('trace-long-context');
    await harness.elapse(2000);

    expect(trackedEvent(harness, 'appeared')).toMatchObject({
      kfc_model_id: 'k3',
      kfc_trace_id: 'trace-long-context',
    });
    expect(harness.track).toHaveBeenCalledWith(
      'long_context_survey',
      expect.objectContaining({ event_type: 'appeared' }),
    );
  });

  it('keeps the pending trace id across an interleaved non-user turn', async () => {
    const harness = createHarness();
    useModel(harness);
    await harness.flush();
    harness.clock.mono += 600_000;
    runUserTurns(harness, [undefined, undefined, undefined, undefined, 'trace-user']);
    harness.host.turnStarted(false);
    harness.host.turnEnded(undefined);
    await harness.elapse(2000);

    expect(trackedEvent(harness, 'appeared')).toMatchObject({ kfc_trace_id: 'trace-user' });
  });

  it('drops the pending trace id once a new user turn starts', async () => {
    const harness = createHarness();
    useModel(harness);
    await harness.flush();
    harness.clock.mono += 600_000;
    runUserTurns(harness, [undefined, undefined, undefined, 'trace-stale', undefined]);
    await harness.elapse(2000);

    expect(trackedEvent(harness, 'appeared')['kfc_trace_id']).toBeUndefined();
  });

  it('attributes lifecycle events to the snapshot session after the session is torn down', async () => {
    const harness = createHarness();
    harness.env.sessionId = 'session-A';
    await harness.flush();
    await harness.appear();

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'appeared' }),
      { sessionId: 'session-A' },
    );

    harness.host.choose('1');
    harness.env.sessionId = '';
    await harness.elapse(3000);

    expect(harness.track).toHaveBeenCalledWith(
      'feedback_survey',
      expect.objectContaining({ event_type: 'responded', response: 'bad' }),
      { sessionId: 'session-A' },
    );
  });
});

describe('session rating copilot stats', () => {
  it('counts Agent tool spawns with their deduplicated sorted models', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    for (let turn = 1; turn <= 5; turn++) {
      harness.host.turnStarted(true);
      harness.host.toolCallStarted(`tc-agent-${String(turn)}`, 'Agent');
      harness.host.subagentSpawned({
        parentToolCallId: `tc-agent-${String(turn)}`,
        model: turn % 2 === 0 ? 'k3' : 'k2',
      });
      harness.host.toolCallEnded(`tc-agent-${String(turn)}`);
      harness.host.turnEnded();
    }
    await harness.elapse(2000);

    expect(trackedEvent(harness, 'appeared')).toMatchObject({
      subagent_count: 5,
      subagent_models: 'k2,k3',
      swarm_run_count: 0,
    });
    expect(trackedEvent(harness, 'appeared')['swarm_models']).toBeUndefined();
  });

  it('counts AgentSwarm runs and member models without inflating subagent stats', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    for (let turn = 1; turn <= 5; turn++) {
      harness.host.turnStarted(true);
      harness.host.turnEnded();
    }
    harness.host.toolCallStarted('tc-swarm-1', 'AgentSwarm');
    harness.host.subagentSpawned({
      parentToolCallId: 'tc-swarm-1',
      swarmIndex: 0,
      model: 'k2',
    });
    harness.host.subagentSpawned({
      parentToolCallId: 'tc-swarm-1',
      swarmIndex: 1,
      model: 'k2',
    });
    harness.host.toolCallEnded('tc-swarm-1');
    await harness.elapse(2000);

    const appeared = trackedEvent(harness, 'appeared');
    expect(appeared).toMatchObject({ subagent_count: 0, swarm_run_count: 1, swarm_models: 'k2' });
    expect(appeared['subagent_models']).toBeUndefined();
  });

  it('ignores spawns parented to tools outside the two families', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.host.toolCallStarted('tc-tower', 'TowerSpawn');
    harness.host.subagentSpawned({ parentToolCallId: 'tc-tower', model: 'k2' });
    harness.host.toolCallEnded('tc-tower');
    await harness.elapse(2000);

    const appeared = trackedEvent(harness, 'appeared');
    expect(appeared).toMatchObject({ subagent_count: 0, swarm_run_count: 0 });
    expect(appeared['subagent_models']).toBeUndefined();
    expect(appeared['swarm_models']).toBeUndefined();
  });

  it('falls back to swarmIndex and the subagent family for unmapped tool calls', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.host.subagentSpawned({
      parentToolCallId: 'tc-missing',
      swarmIndex: 3,
      model: 'k3',
    });
    harness.host.subagentSpawned({ parentToolCallId: 'tc-gone', model: 'k2' });
    harness.host.subagentSpawned({ model: 'k2' });
    await harness.elapse(2000);

    const appeared = trackedEvent(harness, 'appeared');
    expect(appeared).toMatchObject({
      subagent_count: 2,
      subagent_models: 'k2',
      swarm_run_count: 0,
      swarm_models: 'k3',
    });
  });

  it('always reports numeric counts and omits empty model lists', async () => {
    const harness = createHarness();
    await harness.flush();
    await harness.appear();

    const appeared = trackedEvent(harness, 'appeared');
    expect(appeared).toMatchObject({ subagent_count: 0, swarm_run_count: 0 });
    expect(appeared['subagent_models']).toBeUndefined();
    expect(appeared['swarm_models']).toBeUndefined();
  });

  it('seeds subagent_count from resumed agents metadata', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.host.seedResumedAgents({
      main: { type: 'main' },
      'agent-1': { type: 'sub' },
      'agent-2': { type: 'sub', swarmItem: 'task one' },
      'agent-3': { type: 'sub' },
      'agent-4': { type: 'independent' },
      'agent-5': { type: 'sub', profileName: 'tower-worker' },
      'agent-6': { type: 'sub', profileName: 'coder' },
      'agent-7': { type: 'sub', profileName: 'coder', sessionInit: 'agents-md' },
    });
    await harness.appear();

    expect(trackedEvent(harness, 'appeared')).toMatchObject({
      subagent_count: 3,
      swarm_run_count: 0,
    });
  });

  it('ignores session-init agents at runtime', async () => {
    const harness = createHarness();
    await harness.flush();
    harness.clock.mono += 600_000;
    harness.runTurns(5);
    harness.host.subagentSpawned({
      parentToolCallId: 'generate-agents-md',
      model: 'k2',
    });
    await harness.elapse(2000);

    const appeared = trackedEvent(harness, 'appeared');
    expect(appeared).toMatchObject({ subagent_count: 0, swarm_run_count: 0 });
    expect(appeared['subagent_models']).toBeUndefined();
  });
});
