import type { createKimiDeviceId as createKimiDeviceIdFn } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPrompt } from '#/cli/run-prompt';

type CreateKimiDeviceId = typeof createKimiDeviceIdFn;

const mocks = vi.hoisted(() => {
  const eventHandlers = new Set<(event: any) => void>();
  const agentEvent = (agentId: string, event: Record<string, unknown>) => ({
    sessionId: 'ses_prompt',
    agentId,
    ...event,
  });
  const mainEvent = (event: Record<string, unknown>) => agentEvent('main', event);
  const defaultPromptImpl = async (_command?: string) => {
    for (const handler of eventHandlers) {
      handler(mainEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: 'hello' }));
      handler(mainEvent({ type: 'assistant.delta', turnId: 1, delta: ' world' }));
      handler(mainEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    }
  };
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
    listBackgroundTasks: vi.fn(async () => [] as readonly unknown[]),
    prompt: vi.fn(defaultPromptImpl),
  };

  return {
    session,
    eventHandlers,
    agentEvent,
    mainEvent,
    defaultPromptImpl,
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

function opts(overrides: Partial<Parameters<typeof runPrompt>[0]> = {}) {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    inputFormat: undefined,
    finalMessageOnly: false,
    prompt: 'say hello',
    skillsDirs: [],
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
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.clearAllMocks();
    mocks.eventHandlers.clear();
    mocks.session.prompt.mockImplementation(mocks.defaultPromptImpl);
    mocks.session.listBackgroundTasks.mockResolvedValue([]);
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
    });
    expect(mocks.session.setPermission).not.toHaveBeenCalled();
    expect(mocks.session.setApprovalHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.session.setQuestionHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.session.prompt).toHaveBeenCalledWith('say hello');
    expect(stdout.text()).toBe('• hello world\n\n');
    expect(stderr.text()).toBe('To resume this session: kimi -r ses_prompt\n');
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
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

  it('writes stream-json thinking as its own JSONL line before the assistant content', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 9, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 9, delta: 'let me ' }));
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 9, delta: 'think' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 9, delta: 'the answer' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 9, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","type":"thinking","content":"let me think"}',
        '{"role":"assistant","content":"the answer"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
    expect(stderr.text()).toBe('');
  });

  it('writes stream-json thinking before tool calls and keeps the full chain order', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 10, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 10, delta: 'inspect dir' }));
        handler(
          mocks.mainEvent({
            type: 'tool.call.started',
            turnId: 10,
            toolCallId: 'tc_1',
            name: 'Bash',
            args: { command: 'ls' },
          }),
        );
        handler(
          mocks.mainEvent({ type: 'tool.result', turnId: 10, toolCallId: 'tc_1', output: 'file1' }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 10, delta: 'found it' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 10, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","type":"thinking","content":"inspect dir"}',
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tc_1","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
        '{"role":"tool","tool_call_id":"tc_1","content":"file1"}',
        '{"role":"assistant","content":"found it"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
  });

  it('flushes stream-json thinking at each step boundary within a turn', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 11, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({ type: 'thinking.delta', turnId: 11, delta: 'step one thinking' }),
        );
        handler(
          mocks.mainEvent({
            type: 'tool.call.started',
            turnId: 11,
            toolCallId: 'tc_1',
            name: 'Bash',
            args: { command: 'ls' },
          }),
        );
        handler(
          mocks.mainEvent({ type: 'tool.result', turnId: 11, toolCallId: 'tc_1', output: 'ok' }),
        );
        handler(
          mocks.mainEvent({ type: 'thinking.delta', turnId: 11, delta: 'step two thinking' }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 11, delta: 'all done' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 11, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","type":"thinking","content":"step one thinking"}',
        '{"role":"assistant","tool_calls":[{"type":"function","id":"tc_1","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
        '{"role":"tool","tool_call_id":"tc_1","content":"ok"}',
        '{"role":"assistant","type":"thinking","content":"step two thinking"}',
        '{"role":"assistant","content":"all done"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
  });

  it('discards partial stream-json thinking when a step retries', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 12, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 12, delta: 'wrong path' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 12, delta: 'partial' }));
        handler(mocks.mainEvent({ type: 'turn.step.retrying', turnId: 12 }));
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 12, delta: 'right path' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 12, delta: 'final' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 12, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","type":"thinking","content":"right path"}',
        '{"role":"assistant","content":"final"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
  });

  it('emits notification events as JSON lines, flushing the assistant first (output C)', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 30, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 30, delta: 'starting' }));
        handler(
          mocks.mainEvent({
            type: 'background.task.terminated',
            info: {
              taskId: 'b1',
              kind: 'agent',
              status: 'completed',
              description: 'build',
              startedAt: 0,
              endedAt: 1,
            },
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 30, delta: 'done' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 30, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","content":"starting"}',
        '{"type":"notification","event":"background.task.terminated","taskId":"b1","kind":"agent","status":"completed","description":"build"}',
        '{"role":"assistant","content":"done"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
  });

  it('does not emit notification JSON in text output mode (output C)', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 31, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'background.task.terminated',
            info: {
              taskId: 'b1',
              kind: 'process',
              status: 'completed',
              description: 'build',
              startedAt: 0,
              endedAt: 1,
            },
          }),
        );
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 31, delta: 'ok' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 31, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('• ok\n\n');
    expect(stdout.text()).not.toContain('notification');
  });

  it('emits only the final assistant message in stream-json final-message-only mode (output B)', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 40, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'turn.step.started', turnId: 40 }));
        handler(mocks.mainEvent({ type: 'thinking.delta', turnId: 40, delta: 'secret' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 40, delta: 'first step' }));
        handler(mocks.mainEvent({ type: 'turn.step.started', turnId: 40 }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 40, delta: 'final' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 40, delta: ' answer' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 40, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json', finalMessageOnly: true }), '1.2.3-test', {
      stdout,
      stderr,
    });

    expect(stdout.text()).toBe('{"role":"assistant","content":"final answer"}\n');
    expect(stderr.text()).toBe('');
  });

  it('emits only the final text in text final-message-only mode and skips the resume hint (output B)', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ finalMessageOnly: true }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe('hello world\n');
    expect(stderr.text()).toBe('');
  });

  it('reads multiple JSON user messages from stdin and runs a turn for each (input A)', async () => {
    mocks.session.prompt.mockImplementation(async (command?: string) => {
      for (const handler of Array.from(mocks.eventHandlers)) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 50, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 50, delta: `echo:${command}` }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 50, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();
    const stdin = (async function* () {
      yield JSON.stringify({ role: 'user', content: 'first' });
      yield JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'second' }] });
    })();

    await runPrompt(
      opts({ inputFormat: 'stream-json', outputFormat: 'stream-json', prompt: undefined }),
      '1.2.3-test',
      { stdout, stderr, stdin },
    );

    expect(mocks.session.prompt).toHaveBeenNthCalledWith(1, 'first');
    expect(mocks.session.prompt).toHaveBeenNthCalledWith(2, 'second');
    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","content":"echo:first"}',
        '{"role":"assistant","content":"echo:second"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
  });

  it('skips blank, malformed, and non-user stdin lines (input A)', async () => {
    mocks.session.prompt.mockImplementation(async (command?: string) => {
      for (const handler of Array.from(mocks.eventHandlers)) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 51, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 51, delta: `echo:${command}` }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 51, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();
    const stdin = (async function* () {
      yield '';
      yield 'not json';
      yield JSON.stringify({ role: 'assistant', content: 'ignore me' });
      yield JSON.stringify({ role: 'user', content: 'real' });
    })();

    await runPrompt(
      opts({ inputFormat: 'stream-json', outputFormat: 'stream-json', prompt: undefined }),
      '1.2.3-test',
      { stdout, stderr, stdin },
    );

    expect(mocks.session.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.session.prompt).toHaveBeenCalledWith('real');
    expect(stdout.text()).toBe(
      [
        '{"role":"assistant","content":"echo:real"}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
    expect(stderr.text()).toContain('Ignoring invalid JSON input line: not json');
    expect(stderr.text()).toContain('Ignoring non-user input message');
  });

  it('reads a single prompt from stdin with --input-format text (input A)', async () => {
    const stdout = writer();
    const stderr = writer();
    const stdin = (async function* () {
      yield 'line one';
      yield 'line two';
    })();

    await runPrompt(opts({ inputFormat: 'text', prompt: undefined }), '1.2.3-test', {
      stdout,
      stderr,
      stdin,
    });

    expect(mocks.session.prompt).toHaveBeenCalledWith('line one\nline two');
    expect(stdout.text()).toBe('• hello world\n\n');
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

  it('restores resumed session permission and reports a failed turn', async () => {
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
    const stderr = writer();

    await runPrompt(opts({ session: 'ses_existing' }), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr,
    });

    expect(stderr.text()).toContain('Error: provider.error: model failed');
    expect(process.exitCode).toBe(1);
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

  it('reports a failed turn to stderr (text mode), sets exit code 1, and still closes resources', async () => {
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
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr,
    });

    expect(stderr.text()).toContain('Error: provider.error: model failed');
    expect(process.exitCode).toBe(1);
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('emits a JSON error line on stdout when the turn fails in stream-json mode (output)', async () => {
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
            error: { code: 'provider.api_error', message: 'model failed', retryable: false },
          }),
        );
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toBe(
      [
        '{"type":"error","code":"provider.api_error","message":"model failed","retryable":false}',
        '{"role":"meta","type":"session.resume_hint","session_id":"ses_prompt","command":"kimi -r ses_prompt","content":"To resume this session: kimi -r ses_prompt"}',
        '',
      ].join('\n'),
    );
    expect(stderr.text()).toBe('');
    expect(process.exitCode).toBe(1);
  });

  it('maps a retryable provider error to exit code 75', async () => {
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
            error: { code: 'provider.rate_limit', message: 'slow down', retryable: true },
          }),
        );
      }
    });
    const stdout = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr: writer(),
    });

    expect(stdout.text()).toContain('"type":"error"');
    expect(stdout.text()).toContain('"retryable":true');
    expect(process.exitCode).toBe(75);
  });

  it('reports a filtered response as a JSON error in stream-json mode', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 2,
            reason: 'filtered',
          }),
        );
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toContain(
      '{"type":"error","code":"provider.filtered","message":"Provider safety policy blocked the response.","retryable":false}',
    );
    expect(process.exitCode).toBe(1);
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('reports a filtered response to stderr in text mode and sets exit code 1', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'turn.ended',
            turnId: 2,
            reason: 'filtered',
          }),
        );
      }
    });
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr,
    });

    expect(stderr.text()).toContain('Provider safety policy blocked the response.');
    expect(process.exitCode).toBe(1);
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(mocks.harnessClose).toHaveBeenCalled();
  });

  it('treats --quiet as text output with final-message-only and no resume hint', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 60, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'turn.step.started', turnId: 60 }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 60, delta: 'first' }));
        handler(mocks.mainEvent({ type: 'turn.step.started', turnId: 60 }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 60, delta: 'final answer' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 60, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ quiet: true, outputFormat: undefined }), '1.2.3-test', {
      stdout,
      stderr,
    });

    expect(stdout.text()).toBe('final answer\n');
    expect(stderr.text()).toBe('');
  });

  it('waits for active background tasks before exit and emits completions (Tier 2)', async () => {
    let listCalls = 0;
    mocks.session.listBackgroundTasks.mockImplementation(async () => {
      listCalls += 1;
      return listCalls === 1 ? [{ taskId: 'b1', status: 'running' }] : [];
    });
    const fakeClock = {
      now: () => 0,
      sleep: vi.fn(async () => {
        // The task terminates while we wait; the drain subscription emits it.
        for (const handler of Array.from(mocks.eventHandlers)) {
          handler(
            mocks.mainEvent({
              type: 'background.task.terminated',
              info: {
                taskId: 'b1',
                kind: 'process',
                status: 'completed',
                description: 'build',
                startedAt: 0,
                endedAt: 1,
              },
            }),
          );
        }
      }),
    };
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr,
      clock: fakeClock,
    });

    expect(fakeClock.sleep).toHaveBeenCalled();
    expect(mocks.session.listBackgroundTasks).toHaveBeenCalledWith({ activeOnly: true });
    expect(stdout.text()).toContain(
      '{"type":"notification","event":"background.task.terminated","taskId":"b1","kind":"process","status":"completed","description":"build"}',
    );
  });

  it('skips the background-task wait when keepAliveOnExit is set via env (Tier 2)', async () => {
    process.env['KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT'] = '1';
    mocks.session.listBackgroundTasks.mockResolvedValue([{ taskId: 'b1', status: 'running' }]);
    const fakeClock = { now: () => 0, sleep: vi.fn(async () => {}) };
    try {
      await runPrompt(opts(), '1.2.3-test', {
        stdout: { write: vi.fn(() => true) },
        stderr: { write: vi.fn(() => true) },
        clock: fakeClock,
      });
    } finally {
      delete process.env['KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT'];
    }

    expect(mocks.session.listBackgroundTasks).not.toHaveBeenCalled();
    expect(fakeClock.sleep).not.toHaveBeenCalled();
  });

  it('stops waiting for background tasks after the print-wait ceiling (Tier 2)', async () => {
    mocks.session.listBackgroundTasks.mockResolvedValue([{ taskId: 'b1', status: 'running' }]);
    let clockMs = 0;
    const fakeClock = {
      now: () => clockMs,
      sleep: vi.fn(async () => {
        clockMs += 10_000_000_000; // jump well past the ceiling
      }),
    };
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', {
      stdout: { write: vi.fn(() => true) },
      stderr,
      clock: fakeClock,
    });

    expect(stderr.text()).toContain('Timed out');
    expect(stderr.text()).toContain('background task');
  });

  it('emits tool.progress as a JSON line on stdout in stream-json mode (activity)', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 70, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'tool.call.started',
            turnId: 70,
            toolCallId: 'tc_1',
            name: 'Bash',
            args: { command: 'build' },
          }),
        );
        handler(
          mocks.mainEvent({
            type: 'tool.progress',
            turnId: 70,
            toolCallId: 'tc_1',
            update: { kind: 'stdout', text: 'compiling...' },
          }),
        );
        handler(
          mocks.mainEvent({ type: 'tool.result', turnId: 70, toolCallId: 'tc_1', output: 'done' }),
        );
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 70, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toContain(
      '{"type":"tool_progress","tool_call_id":"tc_1","kind":"stdout","text":"compiling..."}',
    );
    expect(stderr.text()).toBe('');
  });

  it('keeps tool.progress on stderr (not JSON) in text mode', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 70, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'tool.progress',
            turnId: 70,
            toolCallId: 'tc_1',
            update: { kind: 'stdout', text: 'building' },
          }),
        );
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 70, reason: 'completed' }));
      }
    });
    const stdout = writer();
    const stderr = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toContain('building');
    expect(stdout.text()).not.toContain('tool_progress');
  });

  it('emits subagent lifecycle events as JSON lines in stream-json mode (activity)', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 71, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'subagent.spawned',
            subagentId: 'a1',
            subagentName: 'researcher',
            parentToolCallId: 'tc_1',
            runInBackground: false,
          }),
        );
        handler(
          mocks.mainEvent({
            type: 'subagent.completed',
            subagentId: 'a1',
            resultSummary: 'found it',
          }),
        );
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 71, reason: 'completed' }));
      }
    });
    const stdout = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr: writer(),
    });

    expect(stdout.text()).toContain(
      '{"type":"subagent","event":"subagent.spawned","subagent_id":"a1","name":"researcher","run_in_background":false}',
    );
    expect(stdout.text()).toContain(
      '{"type":"subagent","event":"subagent.completed","subagent_id":"a1","result_summary":"found it"}',
    );
  });

  it('emits warning, skill and tool-list activity events as JSON lines', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 72, origin: { kind: 'user' } }));
        handler(mocks.mainEvent({ type: 'warning', message: 'low disk', code: 'disk.low' }));
        handler(
          mocks.mainEvent({
            type: 'skill.activated',
            activationId: 's1',
            skillName: 'deploy',
            trigger: 'model-tool',
          }),
        );
        handler(
          mocks.mainEvent({
            type: 'tool.list.updated',
            reason: 'mcp.connected',
            serverName: 'fs',
          }),
        );
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 72, reason: 'completed' }));
      }
    });
    const stdout = writer();

    await runPrompt(opts({ outputFormat: 'stream-json' }), '1.2.3-test', {
      stdout,
      stderr: writer(),
    });

    expect(stdout.text()).toContain('{"type":"warning","message":"low disk","code":"disk.low"}');
    expect(stdout.text()).toContain(
      '{"type":"skill_activated","skill_name":"deploy","trigger":"model-tool"}',
    );
    expect(stdout.text()).toContain(
      '{"type":"tool_list_updated","reason":"mcp.connected","server_name":"fs"}',
    );
  });

  it('does not emit activity events in text mode', async () => {
    mocks.session.prompt.mockImplementationOnce(async () => {
      for (const handler of mocks.eventHandlers) {
        handler(mocks.mainEvent({ type: 'turn.started', turnId: 73, origin: { kind: 'user' } }));
        handler(
          mocks.mainEvent({
            type: 'subagent.spawned',
            subagentId: 'a1',
            subagentName: 'researcher',
            parentToolCallId: 'tc_1',
            runInBackground: false,
          }),
        );
        handler(mocks.mainEvent({ type: 'warning', message: 'low disk' }));
        handler(mocks.mainEvent({ type: 'assistant.delta', turnId: 73, delta: 'ok' }));
        handler(mocks.mainEvent({ type: 'turn.ended', turnId: 73, reason: 'completed' }));
      }
    });
    const stdout = writer();

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr: writer() });

    expect(stdout.text()).toBe('• ok\n\n');
    expect(stdout.text()).not.toContain('subagent');
    expect(stdout.text()).not.toContain('warning');
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
});
