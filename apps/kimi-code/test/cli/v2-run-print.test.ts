import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentCronService,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentScopeContext,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IEventDispatcher,
  IFileSystemStorageService,
  IOAuthToolkit,
  ISessionIndex,
  ISessionManager,
  ITelemetryService,
  makeAgentScopeContext,
  resolveKimiHome,
  type BootstrapInput,
  type Event2,
} from '@moonshot-ai/agent-core-v2';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { runV2Print } from '../../src/cli/v2/run-v2-print';

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  ensureMainAgent: vi.fn(),
  createKimiDefaultHeaders: vi.fn(() => ({})),
  resolveKimiHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home'),
  createKimiDeviceId: vi.fn(() => 'device-1'),
  initializeTelemetry: vi.fn(),
  setCrashPhase: vi.fn(),
  setTelemetryContext: vi.fn(),
  setTelemetryModel: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}));

vi.mock('@moonshot-ai/agent-core-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/agent-core-v2')>();
  return {
    ...actual,
    bootstrap: mocks.bootstrap,
    ensureMainAgent: mocks.ensureMainAgent,
  };
});

vi.mock('@moonshot-ai/kimi-code-oauth', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-oauth')>(
    '@moonshot-ai/kimi-code-oauth',
  );
  return {
    ...actual,
    createKimiDefaultHeaders: mocks.createKimiDefaultHeaders,
    createKimiDeviceId: mocks.createKimiDeviceId,
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-telemetry')>();
  return {
    // Keep the real `shouldEnableTelemetry` so the tests exercise the actual
    // KIMI_DISABLE_TELEMETRY semantics; only the side-effecting entry points
    // are stubbed.
    ...actual,
    initializeTelemetry: mocks.initializeTelemetry,
    setCrashPhase: mocks.setCrashPhase,
    setTelemetryContext: mocks.setTelemetryContext,
    setTelemetryModel: mocks.setTelemetryModel,
    shutdownTelemetry: mocks.shutdownTelemetry,
    track: vi.fn(),
    withTelemetryContext: vi.fn(() => ({ track: vi.fn() })),
  };
});

interface FakeScope {
  readonly id: string;
  readonly accessor: { readonly get: (token: unknown) => unknown };
  readonly dispose: ReturnType<typeof vi.fn>;
}

function fakeScope(id: string, services: Map<unknown, unknown>): FakeScope {
  return {
    id,
    accessor: {
      get: (token: unknown) => {
        if (!services.has(token)) throw new Error(`unexpected service request: ${String(token)}`);
        return services.get(token);
      },
    },
    dispose: vi.fn(),
  };
}

function writer() {
  let text = '';
  return {
    write: vi.fn((chunk: string) => {
      text += chunk;
      return true;
    }),
    text: () => text,
  };
}

function opts(overrides: Record<string, unknown> = {}) {
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
  } as const;
}

function makeFakeHarness() {
  // Native event listeners registered on the main agent's IEventBus; the turn
  // emits a streaming assistant delta before completing.
  const eventListeners = new Set<(event: Event2<any>) => void>();
  const profileState: { profileName: string | undefined } = { profileName: undefined };

  const goal = { createGoal: vi.fn(), getGoal: vi.fn() };
  const agentServices = new Map<unknown, unknown>([
    [
      IAgentProfileService,
      {
        bind: vi.fn(async () => {}),
        setModel: vi.fn(async () => ({ model: 'k2' })),
        getModel: () => 'k2',
        data: () => ({ profileName: profileState.profileName }),
      },
    ],
    [IAgentPermissionModeService, { mode: 'auto', setMode: vi.fn() }],
    [IAuthSummaryService, { ensureReady: vi.fn(async () => {}) }],
    [
      IEventBus,
      {
        subscribe: vi.fn((handler: (event: Event2<any>) => void) => {
          eventListeners.add(handler);
          return { dispose: () => eventListeners.delete(handler) };
        }),
      },
    ],
    [
      IAgentPromptService,
      {
        enqueue: vi.fn(async () => {
          // Emit a native assistant delta on the main agent bus, then complete.
          for (const listener of [...eventListeners]) {
            listener({ type: 'assistant.delta', turnId: 1, delta: 'hello world' } as unknown as Event2<any>);
          }
          return {
            launched: Promise.resolve({
              id: 1,
              result: Promise.resolve({ type: 'completed' }),
            }),
          };
        }),
        drain: vi.fn(async () => {}),
        list: vi.fn(() => ({ launching: false, active: undefined, pending: [] })),
      },
    ],
    [IAgentTaskService, { list: vi.fn(() => []), stopAllOnExit: vi.fn(async () => []) }],
    [IAgentCronService, { getNextFireTime: vi.fn(() => null) }],
    [IAgentGoalService, goal],
    [IEventDispatcher, { flush: vi.fn(async () => {}) }],
    [
      IAgentLoopService,
      {
        status: vi.fn(() => ({ state: 'idle', pendingTurnIds: [] })),
        cancel: vi.fn(() => false),
        settled: vi.fn(async () => {}),
        tryAcquireQuiescence: vi.fn(() => ({ dispose: vi.fn() })),
      },
    ],
    [
      IAgentScopeContext,
      makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }),
    ],
  ]);
  const agent = fakeScope('main', agentServices);

  const sessionServices = new Map<unknown, unknown>([
    // drain enumerates agents; empty → no background work to wait on.
    [
      IAgentLifecycleService,
      {
        list: vi.fn(() => []),
        handleOf: vi.fn(() => agent),
      },
    ],
  ]);
  const session = fakeScope('ses_v2', sessionServices);

  const appServices = new Map<unknown, unknown>([
    [
      IConfigService,
      {
        ready: Promise.resolve(),
        get: vi.fn((section: string) => (section === 'defaultModel' ? 'k2' : undefined)),
        // `applyPrintModeConfigDefaults` inspects each section and fills unset
        // keys via the memory layer; an empty section means everything is unset.
        inspect: vi.fn(() => ({ value: {} })),
        set: vi.fn(async () => {}),
        diagnostics: vi.fn(() => []),
      },
    ],
    [
      ISessionManager,
      {
        create: vi.fn(async () => session),
        resume: vi.fn(async () => session),
        get: vi.fn(() => session),
        list: vi.fn(() => [session]),
      } as unknown as ISessionManager,
    ],
    [
      ISessionIndex,
      {
        list: vi.fn(async () => ({ items: [] })),
        get: vi.fn(async (id: string) => ({
          id,
          workspaceId: 'wd_v2',
          cwd: process.cwd(),
          createdAt: 1,
          updatedAt: 1,
          archived: false,
        })),
      },
    ],
    [ISessionIndex, { get: vi.fn(async () => undefined), listRecent: vi.fn(async () => ({ items: [] })) }],
    [
      IBootstrapService,
      {
        platform: 'linux',
        arch: 'x64',
        clientIdentity: {
          productName: 'test-product',
          version: '1.2.3-test',
          platform: 'test_platform',
        },
        osHomeDir: '/home/test',
        getEnv: () => undefined,
      },
    ],
    [IOAuthToolkit, { getCachedAccessToken: vi.fn(async () => undefined) }],
    [IFileSystemStorageService, {}],
    [
      ITelemetryService,
      (() => {
        const svc = {
          addAppender: vi.fn(() => ({ dispose: vi.fn() })),
          setContext: vi.fn(),
          track: vi.fn(),
          track2: vi.fn(),
          shutdown: vi.fn(async () => {}),
          withContext: vi.fn(() => svc),
        };
        return svc;
      })(),
    ],
  ]);
  const app = fakeScope('app', appServices);
  return { app, agent, session, agentServices, sessionServices, appServices, profileState };
}

describe('runV2Print', () => {
  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
    vi.stubEnv('KIMI_MODEL_OUTPUT_FORMAT', '');
    // Pin the telemetry kill-switch to "unset" so the host environment cannot
    // flip the default telemetry-on path these tests exercise.
    vi.stubEnv('KIMI_DISABLE_TELEMETRY', '');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('submits a prompt, renders native events, awaits completion, and drains', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const promptService = agentServices.get(IAgentPromptService) as { enqueue: ReturnType<typeof vi.fn> };
    expect(promptService.enqueue).toHaveBeenCalledWith({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'say hello' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    // Version banner is first, then the rendered assistant output.
    expect(stderr.write).toHaveBeenNthCalledWith(1, 'kimi version 1.2.3-test\n');
    expect(stdout.text()).toContain('hello world');
    expect(app.dispose).toHaveBeenCalled();
  });

  it('passes explicit skill dirs from --skillsDir into bootstrap args', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ skillsDirs: ['/skills'] }) as never, '1.2.3-test', {
      stdout,
      stderr,
    });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.skillDirs).toEqual(['/skills']);
  });

  it('leaves the skill dirs arg unset when --skillsDir is empty', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.skillDirs ?? []).toEqual([]);
  });

  it('seeds explicit agent files from --agentFile and binds the --agent profile', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, appServices, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(
      opts({ agent: 'reviewer', agentFiles: ['/agents/reviewer.md'] }) as never,
      '1.2.3-test',
      { stdout, stderr },
    );

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles).toEqual(['/agents/reviewer.md']);

    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
    expect(sessions.create).toHaveBeenCalledWith({
      workDir: process.cwd(),
      additionalDirs: undefined,
      mainAgentBinding: { profile: 'reviewer', model: 'k2' },
    });
    const profile = agentServices.get(IAgentProfileService) as { bind: ReturnType<typeof vi.fn> };
    expect(profile.bind).not.toHaveBeenCalled();
  });

  it('binds the profile named by --agent-file when --agent is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-agent-file-'));
    const agentFile = join(dir, 'reviewer.md');
    await writeFile(
      agentFile,
      '---\nname: file-reviewer\ndescription: Reviews code.\n---\n\nYou review code.\n',
    );
    const stdout = writer();
    const stderr = writer();
    const { app, agent, appServices, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ agentFiles: [agentFile] }) as never, '1.2.3-test', {
      stdout,
      stderr,
    });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles).toEqual([agentFile]);

    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
    expect(sessions.create).toHaveBeenCalledWith({
      workDir: process.cwd(),
      additionalDirs: undefined,
      mainAgentBinding: { profile: 'file-reviewer', model: 'k2' },
    });
    const profile = agentServices.get(IAgentProfileService) as { bind: ReturnType<typeof vi.fn> };
    expect(profile.bind).not.toHaveBeenCalled();
  });

  it('does not materialize a main agent after fresh profile binding fails', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();
    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
    sessions.create.mockRejectedValueOnce(new Error('Unknown agent profile'));
    mocks.bootstrap.mockReturnValue({ app });

    await expect(
      runV2Print(opts({ agent: 'missing' }) as never, '1.2.3-test', { stdout, stderr }),
    ).rejects.toThrow('Unknown agent profile');

    expect(mocks.ensureMainAgent).not.toHaveBeenCalled();
  });

  it('fails before any turn when --agent-file is invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-agent-file-'));
    const agentFile = join(dir, 'broken.md');
    await writeFile(agentFile, '---\nname: broken\n---\n\nbody\n');
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await expect(
      runV2Print(opts({ agentFiles: [agentFile] }) as never, '1.2.3-test', { stdout, stderr }),
    ).rejects.toThrow(/Invalid agent file/);

    const profile = agentServices.get(IAgentProfileService) as {
      bind: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
  });

  it('leaves the agent files arg unset when --agentFile is empty', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles ?? []).toEqual([]);
  });

  it('passes --agent-file paths through unresolved so the engine can expand ~', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(
      opts({ agent: 'reviewer', agentFiles: ['~/agents/reviewer.md'] }) as never,
      '1.2.3-test',
      { stdout, stderr },
    );

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles).toEqual(['~/agents/reviewer.md']);
  });

  it('treats re-selecting the already-bound profile on resume as a no-op', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices, appServices, profileState } = makeFakeHarness();
    profileState.profileName = 'reviewer';

    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd() });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ session: 'ses_1', agent: 'reviewer' }) as never, '1.2.3-test', {
      stdout,
      stderr,
    });

    const profile = agentServices.get(IAgentProfileService) as {
      bind: ReturnType<typeof vi.fn>;
      setModel: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
    expect(profile.setModel).not.toHaveBeenCalled();
  });

  it('switches the model when resuming with the already-bound profile and an explicit model', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices, appServices, profileState } = makeFakeHarness();
    profileState.profileName = 'reviewer';

    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd() });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(
      opts({ session: 'ses_1', agent: 'reviewer', model: 'new-model' }) as never,
      '1.2.3-test',
      { stdout, stderr },
    );

    const profile = agentServices.get(IAgentProfileService) as {
      bind: ReturnType<typeof vi.fn>;
      setModel: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
    expect(profile.setModel).toHaveBeenCalledWith('new-model');
  });

  it('honors KIMI_DISABLE_TELEMETRY: no cloud appender and no v1 pipeline', async () => {
    vi.stubEnv('KIMI_DISABLE_TELEMETRY', '1');
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const telemetry = appServices.get(ITelemetryService) as {
      addAppender: ReturnType<typeof vi.fn>;
    };
    expect(telemetry.addAppender).not.toHaveBeenCalled();
    expect(mocks.initializeTelemetry).not.toHaveBeenCalled();
    // The run itself is unaffected: the prompt still renders and cleanup runs.
    expect(stdout.text()).toContain('hello world');
    expect(app.dispose).toHaveBeenCalled();
  });

  it('initializes the v1 telemetry pipeline alongside the cloud appender', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const telemetry = appServices.get(ITelemetryService) as {
      addAppender: ReturnType<typeof vi.fn>;
    };
    expect(telemetry.addAppender).toHaveBeenCalledTimes(1);
    expect(mocks.initializeTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith({
      homeDir: resolveKimiHome(),
      deviceId: 'device-1',
      appName: CLI_USER_AGENT_PRODUCT,
      version: '1.2.3-test',
      uiMode: 'print',
      model: 'k2',
      endpoint: expect.any(Function),
      getAccessToken: expect.any(Function),
    });
    // The resolved session id is synced onto the v1 client so crash events and
    // system metrics carry it; the sink model is reconciled too (same value
    // here, since the fresh session uses the configured default).
    expect(mocks.setTelemetryContext).toHaveBeenCalledWith({ sessionId: 'ses_v2' });
    expect(mocks.setTelemetryModel).toHaveBeenCalledWith('k2');
    expect(mocks.setCrashPhase).toHaveBeenCalledWith('runtime');
    expect(mocks.setCrashPhase).toHaveBeenCalledWith('shutdown');
    expect(mocks.shutdownTelemetry).toHaveBeenCalledWith({
      timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS,
    });
  });

  it('reconciles the v1 sink model with the resumed session model', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices, agentServices } = makeFakeHarness();

    // The resumed session's stored model differs from the configured default.
    const profile = agentServices.get(IAgentProfileService) as { getModel: () => string };
    profile.getModel = () => 'resumed-model';
    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd() });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ session: 'ses_1' }) as never, '1.2.3-test', { stdout, stderr });

    // The v1 pipeline was initialized up front with the best-known model, so
    // crash events during session resolution still reach a sink...
    expect(mocks.initializeTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'k2' }),
    );
    // ...and the sink's model was reconciled to the resumed session's real
    // model only after the session resolved.
    expect(mocks.setTelemetryModel).toHaveBeenCalledWith('resumed-model');
    const initOrder = mocks.initializeTelemetry.mock.invocationCallOrder[0];
    const reconcileOrder = mocks.setTelemetryModel.mock.invocationCallOrder[0];
    expect(initOrder).toBeDefined();
    expect(reconcileOrder).toBeGreaterThan(initOrder!);
  });

  it('flushes the wire journal before disposing the app', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const dispatcher = agentServices.get(IEventDispatcher) as {
      flush: ReturnType<typeof vi.fn>;
    };
    expect(dispatcher.flush).toHaveBeenCalled();
    const flushOrder = dispatcher.flush.mock.invocationCallOrder[0];
    const disposeOrder = app.dispose.mock.invocationCallOrder[0];
    expect(flushOrder).toBeDefined();
    expect(disposeOrder).toBeGreaterThan(flushOrder!);
  });

  it('flushes the wire journal when the turn fails', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices } = makeFakeHarness();

    const promptService = agentServices.get(IAgentPromptService) as {
      enqueue: ReturnType<typeof vi.fn>;
    };
    promptService.enqueue.mockResolvedValueOnce({
      launched: Promise.resolve({
        id: 1,
        result: Promise.resolve({
          type: 'failed',
          error: { code: 'provider.overloaded', message: 'llm request failed' },
        }),
      }),
    });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await expect(runV2Print(opts() as never, '1.2.3-test', { stdout, stderr })).rejects.toThrow(
      'provider.overloaded: llm request failed',
    );

    const dispatcher = agentServices.get(IEventDispatcher) as {
      flush: ReturnType<typeof vi.fn>;
    };
    expect(dispatcher.flush).toHaveBeenCalled();
    const flushOrder = dispatcher.flush.mock.invocationCallOrder[0];
    const disposeOrder = app.dispose.mock.invocationCallOrder[0];
    expect(disposeOrder).toBeGreaterThan(flushOrder!);
  });

  it('does not let a wire flush failure mask the turn outcome', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices } = makeFakeHarness();

    const promptService = agentServices.get(IAgentPromptService) as {
      enqueue: ReturnType<typeof vi.fn>;
    };
    promptService.enqueue.mockResolvedValueOnce({
      launched: Promise.resolve({
        id: 1,
        result: Promise.resolve({
          type: 'failed',
          error: { code: 'provider.overloaded', message: 'llm request failed' },
        }),
      }),
    });
    const dispatcher = agentServices.get(IEventDispatcher) as {
      flush: ReturnType<typeof vi.fn>;
    };
    dispatcher.flush.mockRejectedValueOnce(new Error('disk full'));

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await expect(runV2Print(opts() as never, '1.2.3-test', { stdout, stderr })).rejects.toThrow(
      'provider.overloaded: llm request failed',
    );
    expect(app.dispose).toHaveBeenCalled();
  });

  it('cancels and settles the active turn before flushing on a termination signal', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices } = makeFakeHarness();

    const order: string[] = [];
    const loop = agentServices.get(IAgentLoopService) as {
      status: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      settled: ReturnType<typeof vi.fn>;
      tryAcquireQuiescence: ReturnType<typeof vi.fn>;
    };
    loop.status.mockReturnValue({ state: 'running', pendingTurnIds: [] });
    loop.cancel.mockImplementation(() => {
      if (!order.includes('cancel')) order.push('cancel');
      return true;
    });
    loop.settled = vi.fn(async () => {
      if (!order.includes('settled')) order.push('settled');
    });
    const guardDispose = vi.fn();
    loop.tryAcquireQuiescence = vi.fn(() => ({ dispose: guardDispose }));
    const taskService = agentServices.get(IAgentTaskService) as {
      stopAllOnExit: ReturnType<typeof vi.fn>;
    };
    taskService.stopAllOnExit = vi.fn(async () => {
      if (!order.includes('stop')) order.push('stop');
      return [];
    });
    const dispatcher = agentServices.get(IEventDispatcher) as {
      flush: ReturnType<typeof vi.fn>;
    };
    dispatcher.flush = vi.fn(async () => {
      order.push('flush');
    });

    // A turn still in flight when the signal arrives: the prompt queue reports
    // the launch window, then the running prompt, then goes empty.
    const promptService = agentServices.get(IAgentPromptService) as {
      enqueue: ReturnType<typeof vi.fn>;
      drain: ReturnType<typeof vi.fn>;
      list: ReturnType<typeof vi.fn>;
    };
    let settleTurn!: (result: unknown) => void;
    promptService.enqueue.mockResolvedValueOnce({
      launched: Promise.resolve({
        id: 1,
        result: new Promise((resolve) => {
          settleTurn = resolve;
        }),
      }),
    });
    let promptPhase: 'launching' | 'active' | 'empty' = 'launching';
    promptService.list = vi.fn(() => {
      if (promptPhase === 'launching') {
        return { launching: true, active: undefined, pending: [] };
      }
      if (promptPhase === 'active') {
        return { launching: false, active: { id: 'p1' }, pending: [] };
      }
      return { launching: false, active: undefined, pending: [] };
    });

    const handlers = new Map<string, () => Promise<void>>();
    const fakeProcess = {
      once: (signal: string, handler: () => Promise<void>) => {
        handlers.set(signal, handler);
      },
      off: () => {},
      exit: vi.fn((code?: number) => {
        order.push(`exit:${code}`);
      }),
    };

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    const run = runV2Print(opts() as never, '1.2.3-test', {
      stdout,
      stderr,
      process: fakeProcess as never,
    });
    const outcome = run.catch((error: unknown) => error);
    for (let i = 0; i < 100 && !handlers.has('SIGINT'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const onSigint = handlers.get('SIGINT')!;
    settleTurn({ type: 'cancelled', steps: 0, reason: new Error('aborted') });
    const sigintRun = onSigint();
    // The flush must wait for the prompt queue to empty, even with idle loops.
    for (let i = 0; i < 100 && !order.includes('settled'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(promptService.drain).toHaveBeenCalled();
    expect(order).toEqual(['stop', 'cancel', 'settled']);
    promptPhase = 'active';
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(['stop', 'cancel', 'settled']);
    promptPhase = 'empty';
    await sigintRun;

    expect(order).toEqual(['stop', 'cancel', 'settled', 'flush', 'exit:130']);
    // The guard taken during quiesce is only released after app.dispose().
    expect(loop.tryAcquireQuiescence).toHaveBeenCalled();
    const lastGuardRelease = guardDispose.mock.invocationCallOrder.at(-1);
    const appDisposeOrder = app.dispose.mock.invocationCallOrder[0];
    expect(lastGuardRelease).toBeGreaterThan(appDisposeOrder!);
    expect(await outcome).toBeInstanceOf(Error);
  });
});
