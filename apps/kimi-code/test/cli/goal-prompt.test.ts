import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GOAL_EXIT_CODES,
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
} from '#/cli/goal-prompt';
import { runPrompt } from '#/cli/run-prompt';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    goalId: 'g1',
    objective: 'work',
    status: 'complete',
    turnsUsed: 2,
    tokensUsed: 120,
    wallClockMs: 0,
    budget: {} as never,
    ...overrides,
  };
}

describe('goalExitCode', () => {
  it('maps final statuses to distinct codes', () => {
    expect(goalExitCode('complete')).toBe(GOAL_EXIT_CODES.complete);
    expect(goalExitCode('blocked')).toBe(GOAL_EXIT_CODES.blocked);
    expect(goalExitCode('paused')).toBe(GOAL_EXIT_CODES.paused);
    expect(goalExitCode(undefined)).toBe(0);
    // Folded-away statuses map to success (treated as complete/absent).
    expect(goalExitCode('impossible')).toBe(0);
    // The distinct codes are unique across the statuses.
    expect(new Set(Object.values(GOAL_EXIT_CODES)).size).toBe(Object.values(GOAL_EXIT_CODES).length);
  });
});

describe('parseHeadlessGoalCreate', () => {
  it('parses a create command into objective + replace', () => {
    const result = parseHeadlessGoalCreate('/goal Ship feature X');
    expect(result).toEqual({ objective: 'Ship feature X', replace: false });
  });

  it('returns undefined for non-goal prompts and non-create subcommands', () => {
    expect(parseHeadlessGoalCreate('say hello')).toBeUndefined();
    expect(parseHeadlessGoalCreate('/goal status')).toBeUndefined();
    expect(parseHeadlessGoalCreate('/goal pause')).toBeUndefined();
  });

  it('rejects malformed goal create prompts instead of falling through', () => {
    expect(() => parseHeadlessGoalCreate(`/goal ${'x'.repeat(4001)}`)).toThrow(
      'Goal objective is too long',
    );
  });
});

describe('goal summary', () => {
  it('includes id, status, reason, and usage', () => {
    const summary = goalSummaryJson(
      snapshot({
        status: 'blocked',
        terminalReason: 'need creds',
      }) as never,
    );
    expect(summary).toMatchObject({
      type: 'goal.summary',
      goalId: 'g1',
      status: 'blocked',
      reason: 'need creds',
      turnsUsed: 2,
      tokensUsed: 120,
    });
  });

  it('renders a null goal', () => {
    expect(goalSummaryJson(null).status).toBeNull();
    expect(formatGoalSummaryText(null)).toContain('no goal');
  });
});

// --- Integration: runPrompt headless goal path -----------------------------

const mocks = vi.hoisted(() => {
  const eventHandlers = new Set<(event: any) => void>();
  const mainEvent = (event: Record<string, unknown>) => ({ sessionId: 'ses_goal', agentId: 'main', ...event });
  const session = {
    id: 'ses_goal',
    setModel: vi.fn(),
    setPermission: vi.fn(),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    getStatus: vi.fn(async () => ({ permission: 'auto', model: 'k2' })),
    createGoal: vi.fn(async () => snapshot({ status: 'active' })),
    getGoal: vi.fn(async () => ({ goal: snapshot({ status: 'complete' }) })),
    getCronTasks: vi.fn(async () => ({ tasks: [] })),
    onEvent: vi.fn((handler: (event: any) => void) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    }),
    prompt: vi.fn(async () => {
      for (const handler of eventHandlers) {
        handler(mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
        handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'done' }));
        handler(mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    }),
    waitForBackgroundTasksOnPrint: vi.fn(async () => {}),
  };
  return {
    session,
    eventHandlers,
    mainEvent,
    experimentalFeatures: [{ id: 'micro_compaction', enabled: true }],
    sessions: [] as Array<{ readonly id: string; readonly workDir: string }>,
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    createKimiHarness: () => ({
      homeDir: '/tmp/kimi-goal-home',
      auth: { getCachedAccessToken: vi.fn() },
      ensureConfigFile: vi.fn(),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'k2', telemetry: true })),
      getConfigDiagnostics: vi.fn(async () => ({ warnings: [] as readonly string[] })),
      getExperimentalFeatures: vi.fn(async () => mocks.experimentalFeatures),
      createSession: vi.fn(async () => mocks.session),
      resumeSession: vi.fn(async () => mocks.session),
      listSessions: vi.fn(async () => mocks.sessions),
      close: vi.fn(),
      track: vi.fn(),
    }),
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: vi.fn(),
  setCrashPhase: vi.fn(),
  shutdownTelemetry: vi.fn(),
  track: vi.fn(),
  setTelemetryContext: vi.fn(),
  withTelemetryContext: vi.fn(() => ({ track: vi.fn() })),
}));

function opts(overrides: Partial<Parameters<typeof runPrompt>[0]> = {}) {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: '/goal Ship feature X',
    skillsDirs: [],
    ...overrides,
  } as Parameters<typeof runPrompt>[0];
}

function writer() {
  let text = '';
  return { write: (chunk: string) => ((text += chunk), true), text: () => text };
}

describe('runPrompt headless goal mode', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    // Pin the experimental engine flag off so runPrompt stays on the v1 path
    // this suite mocks, regardless of the host environment (matches
    // run-prompt.test.ts). With the flag on, runPrompt dispatches to the
    // native v2 runner, which ignores these mocks and hangs the test.
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
    savedExitCode = process.exitCode;
    mocks.experimentalFeatures = [{ id: 'micro_compaction', enabled: true }];
    mocks.sessions = [];
    mocks.session.createGoal.mockClear();
    mocks.session.prompt.mockClear();
    mocks.session.waitForBackgroundTasksOnPrint.mockClear();
    mocks.session.getStatus.mockResolvedValue({ permission: 'auto', model: 'k2' } as never);
    mocks.session.getGoal.mockResolvedValue({ goal: snapshot({ status: 'complete' }) } as never);
    mocks.session.getCronTasks.mockResolvedValue({ tasks: [] } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.exitCode = savedExitCode;
  });

  it('creates the goal, runs the turn, and emits a JSON summary on completion', async () => {
    const stdout = writer();
    const stderr = writer();
    await runPrompt(opts({ outputFormat: 'stream-json' }), 'test', {
      stdout,
      stderr,
      process: { once: () => {}, off: () => {}, exit: () => undefined as never },
    });

    expect(mocks.session.createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Ship feature X' }),
    );
    expect(stdout.text()).toContain('"type":"goal.summary"');
    expect(stdout.text()).toContain('"status":"complete"');
  });

  it('sets a distinct exit code for a non-complete final status', async () => {
    mocks.session.getGoal.mockResolvedValue({ goal: snapshot({ status: 'blocked' }) } as never);
    const stdout = writer();
    const stderr = writer();
    await runPrompt(opts(), 'test', {
      stdout,
      stderr,
      process: { once: () => {}, off: () => {}, exit: () => undefined as never },
    });
    expect(process.exitCode).toBe(GOAL_EXIT_CODES.blocked);
  });

  it('uses the completion event snapshot when the goal has already been cleared', async () => {
    const completed = snapshot({ status: 'complete', turnsUsed: 4, tokensUsed: 240 });
    mocks.session.getGoal.mockResolvedValue({ goal: null } as never);
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({
            type: 'goal.updated',
            snapshot: completed,
            change: { kind: 'completion', status: 'complete' },
          }),
        );
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), 'test', {
      stdout,
      stderr,
      process: { once: () => {}, off: () => {}, exit: () => undefined as never },
    });

    expect(stdout.text()).toContain('"status":"complete"');
    expect(stdout.text()).toContain('"turnsUsed":4');
    expect(stdout.text()).not.toContain('"goalId":null');
  });

  it('creates a headless goal without reading experimental features', async () => {
    mocks.experimentalFeatures = [];
    const stdout = writer();
    const stderr = writer();
    await runPrompt(opts(), 'test', {
      stdout,
      stderr,
      process: { once: () => {}, off: () => {}, exit: () => undefined as never },
    });
    expect(mocks.session.createGoal).toHaveBeenCalled();
    expect(mocks.session.prompt).toHaveBeenCalledWith('Ship feature X');
  });

  it('keeps listening across continuation turns until the goal is terminal', async () => {
    const active = snapshot({ status: 'active', turnsUsed: 1, tokensUsed: 80 });
    const completed = snapshot({ status: 'complete', turnsUsed: 2, tokensUsed: 160 });
    mocks.session.getGoal.mockResolvedValueOnce({ goal: active } as never);
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: '1' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
      await Promise.resolve();
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({
            type: 'turn.started',
            turnId: 2,
            origin: { kind: 'system_trigger', name: 'goal_continuation' },
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 2, delta: '2' }));
        handler(
          mocks.mainEvent({
            type: 'goal.updated',
            snapshot: completed,
            change: { kind: 'completion', status: 'complete' },
          }),
        );
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 2, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), 'test', {
      stdout,
      stderr,
      process: { once: () => {}, off: () => {}, exit: () => undefined as never },
    });

    expect(stdout.text()).toBe('• 1\n\n• 2\n\n');
    expect(stderr.text()).toContain('Goal [complete]');
    expect(stderr.text()).toContain('turns: 2');
  });

  it('ignores stale goal checks once a continuation turn has started', async () => {
    const completed = snapshot({ status: 'complete', turnsUsed: 2, tokensUsed: 160 });
    let resolveFirstGoal: ((value: { goal: null }) => void) | undefined;
    const firstGoal = new Promise<{ goal: null }>((resolve) => {
      resolveFirstGoal = resolve;
    });
    mocks.session.getGoal
      .mockImplementationOnce(() => firstGoal as never)
      .mockResolvedValue({ goal: null } as never);
    mocks.session.prompt.mockImplementationOnce(async () => {
      const emit = (event: Record<string, unknown>) => {
        for (const handler of [...mocks.eventHandlers]) {
          handler(mocks.mainEvent(event));
        }
      };
      emit({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } });
      emit({ type: 'assistant.delta', turnId: 1, delta: '1' });
      emit({ type: 'turn.ended', turnId: 1, reason: 'completed' });
      emit({
        type: 'turn.started',
        turnId: 2,
        origin: { kind: 'system_trigger', name: 'goal_continuation' },
      });
      emit({ type: 'assistant.delta', turnId: 2, delta: '2' });
      emit({
        type: 'goal.updated',
        snapshot: completed,
        change: { kind: 'completion', status: 'complete' },
      });
      resolveFirstGoal?.({ goal: null });
      await Promise.resolve();
      emit({ type: 'assistant.delta', turnId: 2, delta: ' tail' });
      emit({ type: 'turn.ended', turnId: 2, reason: 'completed' });
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), 'test', {
      stdout,
      stderr,
      process: { once: () => {}, off: () => {}, exit: () => undefined as never },
    });

    expect(stdout.text()).toBe('• 1\n\n• 2 tail\n\n');
    expect(stderr.text()).toContain('Goal [complete]');
  });

  it('does not send an invalid goal create prompt as a normal prompt', async () => {
    const stdout = writer();
    const stderr = writer();

    await expect(
      runPrompt(opts({ prompt: `/goal ${'x'.repeat(4001)}` }), 'test', {
        stdout,
        stderr,
        process: { once: () => {}, off: () => {}, exit: () => undefined as never },
      }),
    ).rejects.toThrow('Goal objective is too long');

    expect(mocks.session.createGoal).not.toHaveBeenCalled();
    expect(mocks.session.prompt).not.toHaveBeenCalled();
  });

  it('validates the resumed session model before creating a headless goal', async () => {
    mocks.sessions = [{ id: 'ses_goal', workDir: process.cwd() }];
    mocks.session.getStatus.mockResolvedValueOnce({ permission: 'auto', model: '' } as never);
    const stdout = writer();
    const stderr = writer();

    await expect(
      runPrompt(opts({ session: 'ses_goal' }), 'test', {
        stdout,
        stderr,
        process: { once: () => {}, off: () => {}, exit: () => undefined as never },
      }),
    ).rejects.toThrow('No model configured');

    expect(mocks.session.createGoal).not.toHaveBeenCalled();
  });
});
