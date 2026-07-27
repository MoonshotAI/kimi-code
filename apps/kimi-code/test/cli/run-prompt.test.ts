import type { createKimiDeviceId as createKimiDeviceIdFn } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPrompt } from '#/cli/run-prompt';
import { PROMPT_CLEANUP_TIMEOUT_MS } from '#/constant/app';

type CreateKimiDeviceId = typeof createKimiDeviceIdFn;

const mocks = vi.hoisted(() => {
  const eventHandlers = new Set<(event: any) => void>();
  const agentEvent = (agentId: string, event: Record<string, unknown>) => ({
    sessionId: 'ses_prompt',
    agentId,
    ...event,
  });
  const mainEvent = (event: Record<string, unknown>) => agentEvent('main', event);
  const session = {
    id: 'ses_prompt',
    setModel: vi.fn(),
    setPermission: vi.fn(),
    setApprovalHandler: vi.fn(),
    setQuestionHandler: vi.fn(),
    getStatus: vi.fn(
      async (): Promise<{ readonly permission: string; readonly model?: string }> => ({
        permission: 'manual',
      }),
    ),
    onEvent: vi.fn((handler: (event: any) => void) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    }),
    prompt: vi.fn(async () => {
      for (const handler of eventHandlers) {
        handler(
          mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }),
        );
        handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'hello' }));
        handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: ' world' }));
        handler(mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    }),
    waitForBackgroundTasksOnPrint: vi.fn(async () => {}),
    getGoal: vi.fn(async () => ({ goal: null })),
    getCronTasks: vi.fn(async () => ({ tasks: [] })),
    handlePrintMainTurnCompleted: vi.fn(async (): Promise<'finish' | 'continue'> => 'finish'),
  };

  return {
    session,
    eventHandlers,
    agentEvent,
    mainEvent,
    kimiHarnessConstructor: vi.fn(),
    harnessEnsureConfigFile: vi.fn(),
    harnessGetConfig: vi.fn(
      async (): Promise<{ providers: {}; defaultModel?: string; telemetry: boolean }> => ({
        providers: {},
        defaultModel: 'k2',
        telemetry: true,
      }),
    ),
    harnessGetConfigDiagnostics: vi.fn(async () => ({ warnings: [] as readonly string[] })),
    harnessGetExperimentalFeatures: vi.fn(async () => []),
    harnessCreateSession: vi.fn(async () => session),
    harnessResumeSession: vi.fn(async () => session),
    harnessListSessions: vi.fn(async () => [{ id: 'ses_previous', workDir: process.cwd() }]),
    harnessClose: vi.fn(),
    harnessTrack: vi.fn(),
    harnessGetCachedAccessToken: vi.fn(),
    runV2Print: vi.fn(
      async (
        opts: { readonly outputFormat?: string },
        version: string,
        io?: {
          readonly stdout?: { write(chunk: string): boolean };
          readonly stderr?: { write(chunk: string): boolean };
        },
      ) => {
        // Mirror the native runner's output protocol so the version-banner
        // assertions stay meaningful: version first, then the assistant
        // message, then the resume hint — in the active output format.
        const stdout = io?.stdout ?? process.stdout;
        const stderr = io?.stderr ?? process.stderr;
        const outputFormat = opts?.outputFormat ?? 'text';
        if (outputFormat === 'stream-json') {
          stdout.write(
            `${JSON.stringify({ role: 'meta', type: 'system.version', version })}\n`,
          );
          stdout.write(`${JSON.stringify({ role: 'assistant', content: 'hello world' })}\n`);
          stdout.write(
            `${JSON.stringify({
              role: 'meta',
              type: 'session.resume_hint',
              session_id: 'ses_prompt',
              command: 'kimi -r ses_prompt',
              content: 'To resume this session: kimi -r ses_prompt',
            })}\n`,
          );
          return;
        }
        stderr.write(`kimi version ${version}\n`);
        stdout.write('• hello world\n\n');
        stderr.write('To resume this session: kimi -r ses_prompt\n');
      },
    ),
    initializeTelemetry: vi.fn(),
    setCrashPhase: vi.fn(),
    shutdownTelemetry: vi.fn(),
    telemetryTrack: vi.fn(),
    setTelemetryContext: vi.fn(),
    lifecycleTrack: vi.fn(),
    withTelemetryContext: vi.fn(() => ({ track: vi.fn() })),
    createKimiDeviceId: vi.fn<CreateKimiDeviceId>(() => 'device-1'),
    resolveKimiHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home'),
    harnessCreatesDeviceIdOnConstruction: false,
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
    createKimiHarness: (...args: unknown[]) => {
      const options = args[0] as { readonly homeDir?: string } | undefined;
      const homeDir = options?.homeDir ?? '/tmp/kimi-code-test-home';
      if (mocks.harnessCreatesDeviceIdOnConstruction) {
        mocks.createKimiDeviceId(homeDir);
      }
      mocks.kimiHarnessConstructor(...args);
      return {
        homeDir,
        auth: { getCachedAccessToken: mocks.harnessGetCachedAccessToken },
        ensureConfigFile: mocks.harnessEnsureConfigFile,
        getConfig: mocks.harnessGetConfig,
        getConfigDiagnostics: mocks.harnessGetConfigDiagnostics,
        getExperimentalFeatures: mocks.harnessGetExperimentalFeatures,
        createSession: mocks.harnessCreateSession,
        resumeSession: mocks.harnessResumeSession,
        listSessions: mocks.harnessListSessions,
        close: mocks.harnessClose,
        track: mocks.harnessTrack,
      };
    },
  };
});

vi.mock('@moonshot-ai/kimi-code-oauth', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-oauth')>(
    '@moonshot-ai/kimi-code-oauth',
  );
  return {
    ...actual,
    createKimiDeviceId: mocks.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: 'kimi-code',
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setCrashPhase: mocks.setCrashPhase,
  shutdownTelemetry: mocks.shutdownTelemetry,
  track: mocks.telemetryTrack,
  setTelemetryContext: mocks.setTelemetryContext,
  withTelemetryContext: mocks.withTelemetryContext,
}));

// The experimental v2 engine is loaded via a dynamic import from run-prompt.ts
// when KIMI_CODE_EXPERIMENTAL_FLAG is set. Mock the native v2 runner so tests
// that flip that flag can exercise the dispatch without pulling in the real
// agent-core-v2 graph.
vi.mock('../../src/cli/v2/run-v2-print', () => ({
  runV2Print: mocks.runV2Print,
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
    prompt: 'say hello',
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    addDirs: [],
    ...overrides,
  };
}

function writer(columns?: number) {
  let text = '';
  return {
    columns,
    write: vi.fn((chunk: string) => {
      text += chunk;
      return true;
    }),
    text: () => text,
  };
}

function fakeProcess() {
  const listeners = new Map<NodeJS.Signals, () => Promise<void> | void>();
  return {
    once: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
      listeners.set(signal, listener);
    }),
    off: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
      if (listeners.get(signal) === listener) {
        listeners.delete(signal);
      }
    }),
    exit: vi.fn(),
    listener: (signal: NodeJS.Signals) => listeners.get(signal),
  };
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe('runPrompt', () => {
  beforeEach(() => {
    // Pin the experimental engine flag off so the default v1 path is
    // deterministic regardless of the host environment. Tests that exercise the
    // experimental path opt back in explicitly with `vi.stubEnv(..., '1')`.
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
    vi.stubEnv('KIMI_MODEL_OUTPUT_FORMAT', '');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.eventHandlers.clear();
    mocks.createKimiDeviceId.mockImplementation(() => 'device-1');
    mocks.resolveKimiHome.mockImplementation(
      (homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home',
    );
    mocks.harnessCreatesDeviceIdOnConstruction = false;
  });

  it('creates a fresh auto-permission session and streams assistant output to stdout', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ skillsDirs: ['/skills'] }), '1.2.3-test', { stdout, stderr });

    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ skillDirs: ['/skills'], uiMode: 'print' }),
    );
    expect(mocks.harnessCreateSession).toHaveBeenCalledWith({
      workDir: process.cwd(),
      model: 'k2',
      permission: 'auto',
      additionalDirs: undefined,
      drainAgentTasksOnStop: true,
    });
    expect(mocks.session.setPermission).not.toHaveBeenCalled();
    expect(mocks.session.setApprovalHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.session.setQuestionHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.session.prompt).toHaveBeenCalledWith('say hello');
    expect(stdout.text()).toBe('• hello world\n\n');
    expect(stderr.text()).toBe('To resume this session: kimi -r ses_prompt\n');
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_prompt' }),
    );
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('completes even if harness.close() never resolves (cleanup is time-bounded)', async () => {
    vi.useFakeTimers();
    try {
      const stdout = writer();
      const stderr = writer();
      // Simulate a shutdown step that hangs (e.g. a wedged SessionEnd hook or a
      // blackholed connection in a firewalled sandbox). A completed headless run
      // must not stay alive forever waiting on cleanup.
      mocks.harnessClose.mockReturnValueOnce(new Promise<void>(() => {}));

      let settled = false;
      const done = runPrompt(opts(), '1.2.3-test', {
        stdout,
        stderr,
        process: fakeProcess(),
      }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(PROMPT_CLEANUP_TIMEOUT_MS + 100);
      await done;

      expect(settled).toBe(true);
      expect(mocks.harnessClose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a cleanup failure that settles before the timeout', async () => {
    const stdout = writer();
    const stderr = writer();
    // A cleanup step that fails fast (e.g. a permission restore or harness close
    // hitting a persistence error) must surface — not be silently swallowed by
    // the timeout guard — otherwise the run reports success while shutdown
    // actually failed (e.g. a resumed session left in `auto`).
    mocks.harnessClose.mockRejectedValueOnce(new Error('close failed'));

    await expect(
      runPrompt(opts(), '1.2.3-test', { stdout, stderr, process: fakeProcess() }),
    ).rejects.toThrow('close failed');
  });

  it('ignores a cleanup rejection that lands after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const stdout = writer();
      const stderr = writer();
      // Cleanup overruns the bound and only rejects later. The run already gave
      // up waiting and resolved; that late rejection must not flip it to a
      // failure (nor surface as an unhandled rejection).
      mocks.harnessClose.mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('late close')),
            PROMPT_CLEANUP_TIMEOUT_MS + 5000,
          );
          timer.unref?.();
        }),
      );

      let settled: 'resolved' | 'rejected' | undefined;
      const done = runPrompt(opts(), '1.2.3-test', {
        stdout,
        stderr,
        process: fakeProcess(),
      }).then(
        () => {
          settled = 'resolved';
        },
        () => {
          settled = 'rejected';
        },
      );

      await vi.advanceTimersByTimeAsync(PROMPT_CLEANUP_TIMEOUT_MS + 100);
      await done;
      expect(settled).toBe('resolved');

      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      expect(settled).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops prompt startup when session creation fails', async () => {
    const stdout = writer();
    const stderr = writer();
    mocks.harnessCreateSession.mockRejectedValueOnce(new Error('Git Bash missing'));

    await expect(runPrompt(opts(), '1.2.3-test', { stdout, stderr })).rejects.toThrow(
      'Git Bash missing',
    );

    expect(mocks.harnessEnsureConfigFile).toHaveBeenCalledOnce();
    expect(mocks.harnessGetConfig).toHaveBeenCalledOnce();
    expect(mocks.harnessCreateSession).toHaveBeenCalledOnce();
    expect(mocks.session.prompt).not.toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalledOnce();
  });

  it('uses the CLI model override when creating a fresh prompt session', async () => {
    await runPrompt(opts({ model: 'kimi-code/k2.5' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessCreateSession).toHaveBeenCalledWith({
      workDir: process.cwd(),
      model: 'kimi-code/k2.5',
      permission: 'auto',
      additionalDirs: undefined,
      drainAgentTasksOnStop: true,
    });
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi-code/k2.5' }),
    );
  });

  it('passes the CLI additional directory when creating a fresh prompt session', async () => {
    await runPrompt(opts({ addDirs: ['../shared', '/tmp/extra'] }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessCreateSession).toHaveBeenCalledWith({
      workDir: process.cwd(),
      model: 'k2',
      permission: 'auto',
      additionalDirs: ['../shared', '/tmp/extra'],
      drainAgentTasksOnStop: true,
    });
  });

  it('tracks first launch in prompt mode before harness construction can create the device id', async () => {
    mocks.harnessCreatesDeviceIdOnConstruction = true;
    const createdHomes = new Set<string>();
    mocks.createKimiDeviceId.mockImplementation((homeDir, options) => {
      const deviceId = `device-for-${homeDir}`;
      if (!createdHomes.has(homeDir)) {
        createdHomes.add(homeDir);
        options?.onFirstLaunch?.(deviceId);
      }
      return deviceId;
    });

    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.createKimiDeviceId).toHaveBeenNthCalledWith(
      1,
      '/tmp/kimi-code-test-home',
      expect.objectContaining({ onFirstLaunch: expect.any(Function) }),
    );
    expect(mocks.createKimiDeviceId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.kimiHarnessConstructor.mock.invocationCallOrder[0]!,
    );
    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/tmp/kimi-code-test-home' }),
    );
    expect(mocks.harnessTrack).toHaveBeenCalledWith('first_launch');
  });

  it('formats thinking and assistant output as transcript blocks', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 3, origin: { kind: 'user' } }),
        );
        handler(
          mocks.mainEvent({
            type: 'thinking.delta',
            turnId: 3,
            delta: 'The user wants an exact reply.',
          }),
        );
        handler(
          mocks.mainEvent({
            type: 'thinking.delta',
            turnId: 3,
            delta: '\nNo tools are needed.',
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 3, delta: 'prompt-mode-ok' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 3, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toBe(
      '• The user wants an exact reply.\n  No tools are needed.\n\nTo resume this session: kimi -r ses_prompt\n',
    );
    expect(stdout.text()).toBe('• prompt-mode-ok\n\n');
    expect(stderr.write).toHaveBeenNthCalledWith(1, '• The user wants an exact reply.');
    expect(stderr.write).toHaveBeenNthCalledWith(2, '\n  No tools are needed.');
    expect(stdout.write).toHaveBeenNthCalledWith(1, '• prompt-mode-ok');
  });

  it('formats hook results as their own transcript block', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 3, origin: { kind: 'user' } }),
        );
        handler(
          mocks.mainEvent({
            type: 'hook.result',
            turnId: 3,
            hookEvent: 'UserPromptSubmit',
            content: '{}',
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 3, delta: 'answer' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 3, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• UserPromptSubmit hook\n\n  {}\n\n• answer\n\n');
    expect(stderr.text()).toBe('To resume this session: kimi -r ses_prompt\n');
  });

  it('wraps transcript blocks with hanging indentation when terminal width is known', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 4, origin: { kind: 'user' } }),
        );
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 4, delta: 'thinking-wrap' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 4, delta: 'answer-wrap' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 4, reason: 'completed' }));
      }
    });
    const stdout = writer(10);
    const stderr = writer(10);

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toBe('• thinking\n  -wrap\n\nTo resume this session: kimi -r ses_prompt\n');
    expect(stdout.text()).toBe('• answer-w\n  rap\n\n');
  });

  it('filters prompt output and completion to the main agent turn', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      const emit = (event: Record<string, unknown>) => {
        for (const handler of Array.from(mocks.eventHandlers)) {
          handler(event);
        }
      };

      emit(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      emit(
        mocks.agentEvent('child-agent', {
          type: 'turn.started',
          turnId: 1,
          origin: { kind: 'user' },
        }),
      );
      emit(
        mocks.agentEvent('child-agent', {
          type: 'assistant.delta',
          turnId: 1,
          delta: 'sub answer',
        }),
      );
      emit(mocks.agentEvent('child-agent', { type: 'turn.ended', turnId: 1, reason: 'completed' }));
      await Promise.resolve();
      emit(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'main answer' }));
      emit(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• main answer\n\n');
    expect(stderr.text()).toBe('To resume this session: kimi -r ses_prompt\n');
  });

  it('ignores child-agent error events while the main turn continues', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      const emit = (event: Record<string, unknown>) => {
        for (const handler of Array.from(mocks.eventHandlers)) {
          handler(event);
        }
      };

      emit(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      emit(
        mocks.agentEvent('child-agent', {
          type: 'error',
          code: 'subagent.failed',
          message: 'child failed',
        }),
      );
      await Promise.resolve();
      emit(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'main recovered' }));
      emit(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• main recovered\n\n');
    expect(stderr.text()).toBe('To resume this session: kimi -r ses_prompt\n');
  });

  it('resumes a concrete session and forces auto permission before prompting', async () => {
    await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
    expect(mocks.session.getStatus).toHaveBeenCalled();
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto');
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual');
  });

  it('passes the CLI additional directories when resuming a concrete session', async () => {
    await runPrompt(
      opts({ session: 'ses_existing', addDirs: ['../shared', '/tmp/extra'] }),
      '1.2.3-test',
      {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      },
    );

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({
      id: 'ses_existing',
      additionalDirs: ['../shared', '/tmp/extra'],
    });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
  });

  it('allows resuming a concrete session when Windows workdir uses backslashes', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(String.raw`C:\Users\kimi\project`);
    mocks.harnessListSessions.mockResolvedValueOnce([
      { id: 'ses_existing', workDir: 'C:/Users/kimi/project' },
    ]);

    try {
      await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      });
    } finally {
      cwd.mockRestore();
    }

    expect(mocks.harnessListSessions).toHaveBeenCalledWith({
      sessionId: 'ses_existing',
      workDir: String.raw`C:\Users\kimi\project`,
    });
    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
  });

  it('applies the CLI model override to resumed prompt sessions', async () => {
    await runPrompt(opts({ session: 'ses_existing', model: 'kimi-code/k2.5' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
    expect(mocks.session.setModel).toHaveBeenCalledWith('kimi-code/k2.5');
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi-code/k2.5' }),
    );
  });

  it('writes stream-json output as assistant JSONL with resume meta without transcript bullets', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","content":"hello world"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
    expect(stderr.text()).toBe('');
  });

  it('writes stream-json tool calls and tool results as JSONL messages', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 8, origin: { kind: 'user' } }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 8, delta: 'checking' }));
        handler(
          mocks.mainEvent({
            type: 'tool.call.started',
            turnId: 8,
            toolCallId: 'tc_1',
            name: 'Shell',
            args: { command: 'ls' },
          }),
        );
        handler(
          mocks.mainEvent({
            type: 'tool.result',
            turnId: 8,
            toolCallId: 'tc_1',
            output: 'file1.py\nfile2.py',
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 8, delta: 'done' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 8, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","content":"checking","tool_calls":[{"type":"function","id":"tc_1","function":{"name":"Shell","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
        '{"role":"tool","tool_call_id":"tc_1","content":"file1.py\\nfile2.py"}',
        '{"role":"assistant","content":"done"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
  });

  it('emits a stream-json meta line on retry and discards the failed attempt output', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 10, delta: 'partial attempt' }));
        handler(
          mocks.mainEvent({
            type: 'turn.step.retrying',
            turnId: 10,
            step: 1,
            stepId: 'step-uuid',
            failedAttempt: 1,
            nextAttempt: 2,
            maxAttempts: 3,
            delayMs: 300,
            errorName: 'APIProviderRateLimitError',
            errorMessage: 'llmproxy/openai/responses/resp_abc.json status_code=429',
            statusCode: 429,
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 10, delta: 'final answer' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 10, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    const retryMeta = JSON.stringify({
      role: 'meta',
      type: 'turn.step.retrying',
      failed_attempt: 1,
      next_attempt: 2,
      max_attempts: 3,
      delay_ms: 300,
      error_name: 'APIProviderRateLimitError',
      error_message: 'llmproxy/openai/responses/resp_abc.json status_code=429',
      status_code: 429,
    });
    expect(stdout.text()).toBe(
      [
        retryMeta,
        '{"role":"assistant","content":"final answer"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
    // The failed attempt's partial text must not leak as an assistant line.
    expect(stdout.text()).not.toContain('partial attempt');
    expect(stderr.text()).toBe('');
  });

  it('flushes stream-json assistant output before waiting for background tasks', async () => {
    let releaseWait: () => void = () => {};
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    mocks.session.waitForBackgroundTasksOnPrint.mockImplementationOnce(async () => waitGate);

    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 9, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 9, delta: 'final answer' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 9, reason: 'completed' }));
      }
    });

    const stdout = writer();
    const stderr = writer();
    const runPromise = runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr,
    });

    // The assistant message must be flushed even while the background wait is pending.
    await waitForAssertion(() => {
      expect(stdout.text()).toContain('{"role":"assistant","content":"final answer"}');
    });

    releaseWait();
    await runPromise;
  });

  it('follows a background-steered second main turn before finishing in steer mode', async () => {
    // First end-of-turn: stay alive (a background task is still pending).
    // Second end-of-turn: finish.
    mocks.session.handlePrintMainTurnCompleted
      .mockResolvedValueOnce('continue')
      .mockResolvedValueOnce('finish');

    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 10, delta: 'first' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 10, reason: 'completed' }));
      }
    });

    const stdout = writer();
    const stderr = writer();
    const runPromise = runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr,
    });

    // The first turn's assistant message must be flushed and the end-of-turn
    // policy consulted, while the run stays alive (action === 'continue').
    await waitForAssertion(() => {
      expect(mocks.session.handlePrintMainTurnCompleted).toHaveBeenCalledTimes(1);
      expect(stdout.text()).toContain('{"role":"assistant","content":"first"}');
    });

    // Simulate a background-task completion steering the main agent into a new
    // turn (the runtime does this via turn.steer; here we drive the events
    // directly to verify the driver follows and finishes only after it).
    for (const handler of mocks.eventHandlers) {
      handler(
        mocks.mainEvent({
          type: 'turn.started',
          turnId: 11,
          origin: { kind: 'background_task' },
        }),
      );
      handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 11, delta: 'second' }));
      handler(mocks.mainEvent({ type: 'turn.ended', turnId: 11, reason: 'completed' }));
    }

    await runPromise;

    expect(mocks.session.handlePrintMainTurnCompleted).toHaveBeenCalledTimes(2);
    expect(stdout.text()).toContain('{"role":"assistant","content":"second"}');
  });

  it('resumes a concrete session without a configured default model', async () => {
    mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });
    mocks.session.getStatus.mockResolvedValueOnce({ permission: 'manual', model: 'saved-model' });

    await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_existing' });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'saved-model' }),
    );
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto');
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual');
  });

  it('continues the previous workdir session when --continue is used', async () => {
    await runPrompt(opts({ continue: true }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessListSessions).toHaveBeenCalledWith({ workDir: process.cwd() });
    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_previous' });
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto');
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual');
  });

  it('passes the CLI additional directories when continuing the previous session', async () => {
    await runPrompt(opts({ continue: true, addDirs: ['../shared', '/tmp/extra'] }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({
      id: 'ses_previous',
      additionalDirs: ['../shared', '/tmp/extra'],
    });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
  });

  it('continues a previous session without a configured default model', async () => {
    mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });
    mocks.session.getStatus.mockResolvedValueOnce({ permission: 'manual', model: 'saved-model' });

    await runPrompt(opts({ continue: true }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessListSessions).toHaveBeenCalledWith({ workDir: process.cwd() });
    expect(mocks.harnessResumeSession).toHaveBeenCalledWith({ id: 'ses_previous' });
    expect(mocks.harnessCreateSession).not.toHaveBeenCalled();
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'saved-model' }),
    );
  });

  it('restores resumed session permission even when the turn fails', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 5, origin: { kind: 'user' } }),
        );
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 5,
            reason: 'failed',
            error: { code: 'provider.error', message: 'model failed' },
          }),
        );
      }
    });

    await expect(
      runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      }),
    ).rejects.toThrow('provider.error: model failed');

    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(1, 'auto');
    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual');
    expect(mocks.session.setPermission.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.harnessClose.mock.invocationCallOrder[0]!,
    );
  });

  it('restores resumed session permission before exiting on SIGINT', async () => {
    let releasePrompt!: () => void;
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 6, origin: { kind: 'user' } }),
        );
      }
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const processMock = fakeProcess();
    const run = runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      process: processMock,
    } as Parameters<typeof runPrompt>[2] & { process: ReturnType<typeof fakeProcess> });

    await waitForAssertion(() => {
      expect(mocks.session.setPermission).toHaveBeenCalledWith('auto');
      expect(processMock.listener('SIGINT')).toBeDefined();
    });

    await processMock.listener('SIGINT')?.();

    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual');
    expect(mocks.session.setPermission.mock.invocationCallOrder[1]).toBeLessThan(
      processMock.exit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
    expect(processMock.exit).toHaveBeenCalledWith(130);

    for (const handler of mocks.eventHandlers) {
      handler(mocks.mainEvent({ type: 'turn.ended', turnId: 6, reason: 'completed' }));
    }
    releasePrompt();
    await run;

    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SIGTERM' as NodeJS.Signals, 143],
    ['SIGHUP' as NodeJS.Signals, 129],
  ])('cleans up prompt mode before exiting on %s', async (signal, exitCode) => {
    let releasePrompt!: () => void;
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 7, origin: { kind: 'user' } }),
        );
      }
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const processMock = fakeProcess();
    const run = runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      process: processMock,
    } as Parameters<typeof runPrompt>[2] & { process: ReturnType<typeof fakeProcess> });

    await waitForAssertion(() => {
      expect(processMock.listener(signal)).toBeDefined();
    });

    await processMock.listener(signal)?.();

    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
    expect(processMock.exit).toHaveBeenCalledWith(exitCode);

    for (const handler of mocks.eventHandlers) {
      handler(mocks.mainEvent({ type: 'turn.ended', turnId: 7, reason: 'completed' }));
    }
    releasePrompt();
    await run;

    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it('waits for the pending auto permission write before signal restore', async () => {
    let releaseAutoPermission!: () => void;
    let releasePrompt!: () => void;
    mocks.session.setPermission.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseAutoPermission = resolve;
      });
    });
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 7, origin: { kind: 'user' } }),
        );
      }
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });
    const processMock = fakeProcess();
    const run = runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      process: processMock,
    } as Parameters<typeof runPrompt>[2] & { process: ReturnType<typeof fakeProcess> });

    await waitForAssertion(() => {
      expect(processMock.listener('SIGINT')).toBeDefined();
      expect(mocks.session.setPermission).toHaveBeenCalledWith('auto');
    });
    expect(processMock.once.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.session.setPermission.mock.invocationCallOrder[0]!,
    );

    const signalCleanup = processMock.listener('SIGINT')?.();
    await Promise.resolve();

    expect(mocks.session.setPermission).toHaveBeenCalledTimes(1);

    releaseAutoPermission();
    await signalCleanup;

    expect(mocks.session.setPermission).toHaveBeenNthCalledWith(2, 'manual');
    expect(processMock.exit).toHaveBeenCalledWith(130);

    await waitForAssertion(() => {
      expect(mocks.session.prompt).toHaveBeenCalledWith('say hello');
    });
    for (const handler of mocks.eventHandlers) {
      handler(mocks.mainEvent({ type: 'turn.ended', turnId: 7, reason: 'completed' }));
    }
    releasePrompt();
    await run;
  });

  it('uses auto permission so headless mode can bypass plan approval and questions', async () => {
    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    expect(mocks.harnessCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'auto' }),
    );
  });

  it('throws when no default model is configured', async () => {
    mocks.harnessGetConfig.mockResolvedValueOnce({ providers: {}, telemetry: true });

    await expect(
      runPrompt(opts(), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      }),
    ).rejects.toThrow(
      'No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
    );

    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('rejects when the turn fails and still closes resources', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(
          mocks.mainEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }),
        );
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 2,
            reason: 'failed',
            error: { code: 'provider.error', message: 'model failed' },
          }),
        );
      }
    });

    await expect(
      runPrompt(opts(), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      }),
    ).rejects.toThrow('provider.error: model failed');

    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('rejects with a friendly message when the provider filters the response', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 2,
            reason: 'failed',
            error: {
              code: 'provider.filtered',
              message: 'Provider safety policy blocked the response.',
              name: 'ProviderFilteredError',
              retryable: false,
            },
          }),
        );
      }
    });

    await expect(
      runPrompt(opts(), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
      }),
    ).rejects.toThrow('Provider safety policy blocked the response.');

    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('approval fallback approves if an unexpected approval request reaches SDK', async () => {
    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    const handler = mocks.session.setApprovalHandler.mock.calls[0]![0] as () => unknown;
    expect(handler()).toEqual({ decision: 'approved' });
  });

  it('question fallback returns null so prompt mode never opens a question UI', async () => {
    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
    });

    const handler = mocks.session.setQuestionHandler.mock.calls[0]![0] as () => unknown;
    expect(handler()).toBeNull();
  });

  it('emits the version first in text mode when the experimental flag is enabled', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    // The experimental engine is selected and the version banner is the very
    // first write, ahead of any assistant output or the resume hint.
    expect(mocks.runV2Print).toHaveBeenCalled();
    expect(mocks.kimiHarnessConstructor).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenNthCalledWith(1, 'kimi version 1.2.3-test\n');
    expect(stderr.text().startsWith('kimi version 1.2.3-test\n')).toBe(true);
    expect(stdout.text()).toBe('• hello world\n\n');
  });

  it('emits the version first in stream-json mode when the experimental flag is enabled', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr,
    });

    expect(mocks.runV2Print).toHaveBeenCalled();
    expect(mocks.kimiHarnessConstructor).not.toHaveBeenCalled();
    const lines = stdout.text().split('\n');
    expect(lines[0]).toBe(
      '{"role":"meta","type":"system.version","version":"1.2.3-test"}',
    );
    expect(stderr.text()).toBe('');
  });

  it('does not emit the version when the experimental flag is disabled', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(mocks.runV2Print).not.toHaveBeenCalled();
    expect(mocks.kimiHarnessConstructor).toHaveBeenCalled();
    expect(stderr.text()).not.toContain('kimi version');
  });

  it('does not settle on end_turn while a goal is still active', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'created a goal' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    });
    // First evaluation (after turn 1) sees an active goal; the continuation
    // turn's evaluation sees the goal gone (completed → record cleared).
    mocks.session.getGoal.mockResolvedValueOnce({ goal: { status: 'active' } } as never);

    const stdout = writer();
    const stderr = writer();
    let settled = false;
    const run = runPrompt(opts(), '1.2.3-test', { stdout, stderr }).then(() => {
      settled = true;
    });

    await waitForAssertion(() => {
      expect(mocks.session.getGoal).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);

    // The goal driver launches the continuation turn on its own; the run
    // streams it and settles only once no goal is active anymore.
    for (const handler of mocks.eventHandlers) {
      handler(
        mocks.mainEvent({
          type: 'turn.started',
          turnId: 2,
          origin: { kind: 'system_trigger' },
        }),
      );
      handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 2, delta: 'goal work' }));
      handler(mocks.mainEvent({ type: 'turn.ended', turnId: 2, reason: 'completed' }));
    }

    await run;
    expect(settled).toBe(true);
    expect(stdout.text()).toContain('goal work');
  });

  it('settles when the goal reaches a terminal state between turns with no trailing turn.ended', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'working' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    });
    // Turn 1's evaluation sees the goal still active; the terminal
    // goal.updated (e.g. the driver blocked it on a hard budget) arrives with
    // no further turn.ended and must settle the run itself.
    mocks.session.getGoal
      .mockResolvedValueOnce({ goal: { status: 'active' } } as never)
      .mockResolvedValue({ goal: { status: 'blocked' } } as never);

    const stdout = writer();
    const stderr = writer();
    let settled = false;
    const run = runPrompt(opts(), '1.2.3-test', { stdout, stderr }).then(() => {
      settled = true;
    });

    await waitForAssertion(() => {
      expect(mocks.session.getGoal).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);

    for (const handler of mocks.eventHandlers) {
      handler(
        mocks.mainEvent({
          type: 'goal.updated',
          snapshot: { status: 'blocked' },
          change: { kind: 'blocked' },
        }),
      );
    }

    await run;
    expect(settled).toBe(true);
  });

  it('does not settle on end_turn while a cron task is pending, then lets the fire drive a turn', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'scheduled a reminder' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
      }
    });
    // Turn 1 leaves a pending one-shot cron task; its fire steers turn 2, and
    // by turn 2's evaluation the task has fired and been removed.
    mocks.session.getCronTasks
      .mockResolvedValueOnce({
        tasks: [
          {
            id: '3f9a1c2e',
            cron: '*/5 * * * *',
            recurring: false,
            createdAt: 1,
            lastFiredAt: undefined,
            nextFireAt: Date.now() + 60_000,
          },
        ],
      } as never)
      .mockResolvedValue({ tasks: [] } as never);

    const stdout = writer();
    const stderr = writer();
    let settled = false;
    const run = runPrompt(opts(), '1.2.3-test', { stdout, stderr }).then(() => {
      settled = true;
    });

    await waitForAssertion(() => {
      expect(mocks.session.getCronTasks).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);

    // The cron fire steers a fresh turn; the run streams it and settles once
    // no pending tasks remain.
    for (const handler of mocks.eventHandlers) {
      handler(
        mocks.mainEvent({
          type: 'turn.started',
          turnId: 2,
          origin: { kind: 'cron_job' },
        }),
      );
      handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 2, delta: 'cron ran' }));
      handler(mocks.mainEvent({ type: 'turn.ended', turnId: 2, reason: 'completed' }));
    }

    await run;
    expect(settled).toBe(true);
    expect(stdout.text()).toContain('cron ran');
  });

  it('does not wait for cron tasks whose expression has no future fire', async () => {
    mocks.session.getCronTasks.mockResolvedValue({
      tasks: [
        {
          id: '3f9a1c2e',
          cron: '0 0 31 2 *',
          recurring: true,
          createdAt: 1,
          lastFiredAt: undefined,
          nextFireAt: null,
        },
      ],
    } as never);

    const stdout = writer();
    const stderr = writer();
    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• hello world\n\n');
    expect(mocks.harnessClose).toHaveBeenCalled();
  });
});
