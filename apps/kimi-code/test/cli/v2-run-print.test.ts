import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalize } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentCronService,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentScopeContext,
  IAgentTaskService,
  IAppendLogStore,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEnvironmentService,
  IEventBus,
  IEventDispatcher,
  IEventService,
  IFileSystemStorageService,
  IFlagService,
  ILogService,
  IMcpOAuthService,
  IModelService,
  IOAuthToolkit,
  IProjectAliases,
  IProjectInstanceManager,
  IProjectService,
  IProviderService,
  IRegionService,
  ISessionContext,
  ISessionIndex,
  ISessionIndexMirror,
  ISessionLockService,
  ISessionRunGate,
  ISessionManager,
  ITelemetryService,
  IProjectSessions,
  InMemorySessionLockService,
  Error2,
  ErrorCodes,
  makeAgentScopeContext,
  makeSessionContext,
  resolveKimiHome,
  type BootstrapInput,
  type Event2,
} from '@moonshot-ai/agent-core-v2';

import {
  KimiError,
  SDKRpcClientV2,
  type CreatedWorktree,
  type WorkspaceTrustInfo,
  type WorkspaceTrustMcpServerInfo,
} from '@moonshot-ai/kimi-code-sdk';

import { OptionConflictError } from '#/cli/options';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { runV2Print } from '../../src/cli/v2/run-v2-print';
import { resetKimiRegionCache } from '../../src/utils/region';

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
  readonly instantiation: { readonly disposeAsync: ReturnType<typeof vi.fn> };
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
    instantiation: { disposeAsync: vi.fn(async () => {}) },
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
    environment: undefined,
    addDirs: [],
    ...overrides,
  } as const;
}

function makeFakeHarness(toolUpdates = false) {
  const eventListeners = new Set<(event: Event2<any>) => void>();
  const profileState: { profileName: string | undefined } = { profileName: undefined };
  const planState = { active: false };

  const goal = { createGoal: vi.fn(), getGoal: vi.fn() };
  const agentServices = new Map<unknown, unknown>([
    [
      IAgentProfileService,
      {
        bind: vi.fn(async () => {}),
      },
    ],
    [IAgentPermissionModeService, { mode: 'auto', setMode: vi.fn() }],
    [
      IAgentPlanService,
      {
        status: vi.fn(async () =>
          planState.active ? { id: 'plan-1', content: '', path: '/tmp/plan-1.md' } : null,
        ),
        cancel: vi.fn(() => {
          planState.active = false;
        }),
      },
    ],
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
    [IAgentTaskService, { list: vi.fn(() => []), stop: vi.fn(async () => {}) }],
    [IAgentCronService, { getNextFireTime: vi.fn(() => null) }],
    [IAgentGoalService, goal],
    [IEventDispatcher, { flush: vi.fn(async () => {}) }],
    [
      IAgentLoopService,
      {
        setModel: vi.fn(async () => ({ model: 'k2' })),
        getModel: () => 'k2',
        data: () => ({ profileName: profileState.profileName }),
        submit: vi.fn(() => {
          for (const listener of [...eventListeners]) {
            if (toolUpdates) {
              const base = {
                type: 'tool.updated',
                turnId: 1,
                toolCallId: 'call-1',
                taskId: 'task-1',
                status: 'running',
                detached: false,
              };
              listener({ ...base, fields: { status: 'working' } } as unknown as Event2<any>);
              listener({ ...base, fields: { status: 'working' } } as unknown as Event2<any>);
              listener({ ...base, fields: {}, output: { offset: 0, text: 'chunk' } } as unknown as Event2<any>);
            }
            listener({ type: 'assistant.delta', turnId: 1, delta: 'hello world' } as unknown as Event2<any>);
          }
          return { id: 'p1' };
        }),
        promptHandle: vi.fn(() => ({
          launched: Promise.resolve({
            id: 1,
            result: Promise.resolve({ type: 'completed' }),
          }),
        })),
        snapshot: vi.fn(() => ({
          state: 'idle',
          activeTurnId: undefined,
          activePromptId: undefined,
          queue: [],
          notificationCount: 0,
          paused: false,
          hasPendingRequests: false,
          turn: undefined,
          activeTraceId: undefined,
        })),
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
    [
      IAgentLifecycleService,
      {
        list: vi.fn(() => []),
        handleOf: vi.fn(() => agent),
      },
    ],
    [
      ISessionContext,
      makeSessionContext({
        sessionId: 'ses_v2',
        workspaceId: 'wd_v2',
        sessionDir: '/tmp/ses_v2',
        sessionScope: 'sessions/wd_v2/ses_v2',
        cwd: process.cwd(),
      }),
    ],
    [
      ISessionRunGate,
      {
        begin: vi.fn(() => {}),
        tryHold: vi.fn(() => true),
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
    [IProjectSessions, { listForWorkdir: vi.fn(async () => ({ items: [] })) }],
    [ISessionLockService, new InMemorySessionLockService()],
    [
      IAppendLogStore,
      { externallyModified: vi.fn(() => false), drainRetirements: vi.fn(async () => {}) },
    ],
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
    [IModelService, { ready: Promise.resolve() }],
    [IProviderService, { ready: Promise.resolve() }],
    [IEventService, { subscribe: vi.fn(() => ({ dispose: vi.fn() })) }],
    [ILogService, { warn: vi.fn() }],
    [IMcpOAuthService, { shutdown: vi.fn(async () => {}) }],
    [ISessionIndexMirror, { drain: vi.fn(async () => {}) }],
    [
      IRegionService,
      {
        current: () => ({ region: 'mainland-cn', source: 'env' }),
        refresh: () => ({ region: 'mainland-cn', source: 'env' }),
        getRegionAsync: async () => 'mainland-cn',
      },
    ],
    [IFileSystemStorageService, {}],
    [IFlagService, { enabled: vi.fn(() => false) }],
    [IProjectService, { peekImplicit: vi.fn(async () => ({ id: 'wd_v2', root: process.cwd() })) }],
    [IProjectAliases, { resolveAliasIds: vi.fn(async (id: string) => [id]) }],
    [
      IProjectInstanceManager,
      {
        acquire: vi.fn(async () => ({
          instance: { program: { trust: { get: vi.fn(async () => true) } } },
          dispose: vi.fn(),
        })),
      },
    ],
    [IEnvironmentService, { addProvider: vi.fn(async () => ({ dispose: vi.fn() })) }],
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
  return {
    app,
    agent,
    session,
    agentServices,
    sessionServices,
    appServices,
    profileState,
    planState,
  };
}

const trustInfo = vi.spyOn(SDKRpcClientV2.prototype, 'getWorkspaceTrustInfo');

function gated(...gatedMcpServers: readonly WorkspaceTrustMcpServerInfo[]): WorkspaceTrustInfo {
  return {
    trusted: gatedMcpServers.length === 0,
    projectRoot: '/tmp/project',
    gatedMcpServers,
    gatedAdditionalDirs: [],
    additionalDirSources: [],
    warnings: [],
    instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] },
  };
}

describe('runV2Print', () => {
  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
    vi.stubEnv('KIMI_MODEL_OUTPUT_FORMAT', '');
    vi.stubEnv('KIMI_DISABLE_TELEMETRY', '');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.kimi.com');
    resetKimiRegionCache();
    trustInfo.mockResolvedValue(gated());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetKimiRegionCache();
  });

  it('submits a prompt, renders native events, awaits completion, and drains', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices, appServices } = makeFakeHarness(true);
    const config = appServices.get(IConfigService) as { diagnostics: ReturnType<typeof vi.fn> };
    config.diagnostics.mockReturnValue([
      { severity: 'warning', message: 'deprecated setting' },
      { severity: 'error', message: 'config could not be read' },
    ]);

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const promptService = agentServices.get(IAgentLoopService) as { submit: ReturnType<typeof vi.fn> };
    expect(promptService.submit).toHaveBeenCalledWith({
      role: 'user',
      content: [{ type: 'text', text: 'say hello' }],
      attributes: { origin: { kind: 'user' } },
    });
    expect(stderr.write).toHaveBeenNthCalledWith(1, 'kimi version 1.2.3-test\n');
    expect(stderr.text()).toContain('Warning: deprecated setting\n');
    expect(stderr.text()).toContain('Error: config could not be read\n');
    expect(stderr.text().match(/working/g)).toHaveLength(1);
    expect(stderr.text()).toContain('chunk\n');
    expect(stdout.text()).toContain('hello world');
    expect(app.dispose).toHaveBeenCalled();
  });

  it('keeps local print usable when remote provider registration fails', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();
    const environments = appServices.get(IEnvironmentService) as {
      addProvider: ReturnType<typeof vi.fn>;
    };
    environments.addProvider.mockRejectedValueOnce(new Error('provider unavailable'));
    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toContain('hello world');
    expect(app.dispose).toHaveBeenCalledOnce();
  });

  it('reloads a stale session in place, retries once, and still reports occupied', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices, sessionServices, appServices } = makeFakeHarness();
    const sessions = appServices.get(ISessionManager) as {
      create: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    sessions.close = vi.fn(async () => {});
    const lifecycle = sessionServices.get(IAgentLifecycleService) as {
      list: ReturnType<typeof vi.fn>;
    };
    lifecycle.list.mockReturnValue([{ agentId: 'main' }]);
    const runGate = sessionServices.get(ISessionRunGate) as {
      begin: ReturnType<typeof vi.fn>;
    };
    runGate.begin.mockImplementationOnce(() => {
      throw new Error2(ErrorCodes.SESSION_STALE, 'stale');
    });
    const loop = agentServices.get(IAgentLoopService) as { submit: ReturnType<typeof vi.fn> };
    loop.submit.mockImplementationOnce(() => {
      throw new Error2(ErrorCodes.SESSION_OCCUPIED, 'occupied');
    });
    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    const previousExitCode = process.exitCode;
    try {
      await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

      expect(sessions.create).toHaveBeenCalledTimes(1);
      expect(sessions.close).toHaveBeenCalledTimes(1);
      expect(sessions.resume).toHaveBeenCalledTimes(1);
      expect(loop.submit).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(4);
      expect(stderr.text()).toContain('was updated by another client; reloaded it');
      expect(stderr.text()).toContain('occupied');
    } finally {
      process.exitCode = previousExitCode;
    }
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
    expect(input.args?.nonInteractive).toBe(true);
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

  it('declares the host non-interactive so no approval or question waits for a person', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.nonInteractive).toBe(true);
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

  it('threads the environment flags into the initial session binding', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(
      opts({ environment: 'dev-box', environmentCwd: '/remote/work' }) as never,
      '1.2.3-test',
      { stdout, stderr },
    );

    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
    expect(sessions.create).toHaveBeenCalledWith({
      workDir: process.cwd(),
      additionalDirs: undefined,
      mainAgentBinding: { profile: 'agent', model: 'k2' },
      environmentId: 'dev-box',
      environmentCwd: '/remote/work',
    });
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

  it('resolves relative --agent-file and --skills-dir paths from the directory the command was started in', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'kimi-launch-paths-'));
    const launchDir = join(repository, 'src');
    await mkdir(join(repository, '.git'));
    await mkdir(launchDir);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(launchDir);
    const { app } = makeFakeHarness();
    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    try {
      await runV2Print(
        opts({
          agent: 'reviewer',
          agentFiles: ['my/reviewer.md'],
          skillsDirs: ['./local-skills', '~/team-skills', '/skills'],
          environment: 'local',
          environmentCwd: '/elsewhere',
        }) as never,
        '1.2.3-test',
        { stdout: writer(), stderr: writer() },
      );
    } finally {
      cwd.mockRestore();
      await rm(repository, { recursive: true, force: true });
    }

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles).toEqual([normalize(join(launchDir, 'my', 'reviewer.md'))]);
    expect(input.args?.skillDirs).toEqual([
      normalize(join(repository, 'local-skills')),
      '~/team-skills',
      '/skills',
    ]);
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
    };
    const loop = agentServices.get(IAgentLoopService) as {
      setModel: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
    expect(loop.setModel).not.toHaveBeenCalled();
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
    };
    const loop = agentServices.get(IAgentLoopService) as {
      setModel: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
    expect(loop.setModel).toHaveBeenCalledWith('new-model');
  });

  it('skips default_plan_mode for a new print session and says so on stderr', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices, planState } = makeFakeHarness();
    planState.active = true;

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const plan = agentServices.get(IAgentPlanService) as { cancel: ReturnType<typeof vi.fn> };
    expect(plan.cancel).toHaveBeenCalledTimes(1);
    expect(planState.active).toBe(false);
    expect(stderr.text()).toContain(
      'default_plan_mode is not applied in print mode, because Plan mode waits for your review.',
    );
    const loop = agentServices.get(IAgentLoopService) as { submit: ReturnType<typeof vi.fn> };
    expect(loop.submit).toHaveBeenCalledTimes(1);
  });

  it('leaves a new print session alone when it does not start in Plan mode', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const plan = agentServices.get(IAgentPlanService) as { cancel: ReturnType<typeof vi.fn> };
    expect(plan.cancel).not.toHaveBeenCalled();
    expect(stderr.text()).not.toContain('default_plan_mode');
  });

  it('runs a resumed session that is still in Plan mode and says its plan cannot be approved', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices, appServices, planState } = makeFakeHarness();
    planState.active = true;

    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd() });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ session: 'ses_1' }) as never, '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toContain(
      'Session "ses_1" is in Plan mode, and its plan cannot be approved in print mode; review it with `kimi -r ses_1`.',
    );
    const plan = agentServices.get(IAgentPlanService) as { cancel: ReturnType<typeof vi.fn> };
    expect(plan.cancel).not.toHaveBeenCalled();
    expect(planState.active).toBe(true);
    const permission = agentServices.get(IAgentPermissionModeService) as {
      setMode: ReturnType<typeof vi.fn>;
    };
    expect(permission.setMode).toHaveBeenCalledWith('auto');
    const loop = agentServices.get(IAgentLoopService) as { submit: ReturnType<typeof vi.fn> };
    expect(loop.submit).toHaveBeenCalledTimes(1);
  });

  it('keeps stream-json stdout parseable when the resumed session is still in Plan mode', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices, planState } = makeFakeHarness();
    planState.active = true;

    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd() });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runV2Print(opts({ session: 'ses_1', outputFormat: 'stream-json' }) as never, '1.2.3-test', {
        stdout,
        stderr,
      });

      const lines = stdout.text().split('\n').filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect(stdout.text()).not.toContain('Plan mode');
      expect(stderr.text()).toContain('Session "ses_1" is in Plan mode');
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('continues the previous session that is still in Plan mode and says its plan cannot be approved', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices, appServices, planState } = makeFakeHarness();
    planState.active = true;

    const workdirSessions = appServices.get(IProjectSessions) as { listForWorkdir: ReturnType<typeof vi.fn> };
    workdirSessions.listForWorkdir.mockResolvedValue({ items: [{ id: 'ses_9', cwd: process.cwd() }] });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ continue: true }) as never, '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toContain('Session "ses_9" is in Plan mode, and its plan cannot be approved in print mode');
    expect(planState.active).toBe(true);
    const loop = agentServices.get(IAgentLoopService) as { submit: ReturnType<typeof vi.fn> };
    expect(loop.submit).toHaveBeenCalledTimes(1);
  });

  it('continues the newest session of the working directory from its implicit project', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();
    const workdirSessions = appServices.get(IProjectSessions) as { listForWorkdir: ReturnType<typeof vi.fn> };
    workdirSessions.listForWorkdir.mockResolvedValue({ items: [{ id: 'ses_here', cwd: process.cwd() }] });
    const index = appServices.get(ISessionIndex) as { listRecent: ReturnType<typeof vi.fn> };
    const sessions = appServices.get(ISessionManager) as {
      create: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
    };

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ continue: true }) as never, '1.2.3-test', { stdout, stderr });

    expect(workdirSessions.listForWorkdir).toHaveBeenCalledWith(process.cwd(), { limit: 1 });
    expect(index.listRecent).not.toHaveBeenCalled();
    expect(sessions.resume.mock.calls.map(([id]) => id)).toEqual(['ses_here']);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('starts a fresh session when the working directory has no session to continue', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();
    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ continue: true }) as never, '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toContain(`No sessions to continue under "${process.cwd()}"; starting a fresh session.`);
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ workDir: process.cwd() }));
  });

  it('refuses to resume a session from another project and names that directory', async () => {
    const stdout = writer();
    const stderr = writer();
    const otherDir = await mkdtemp(join(tmpdir(), 'kimi-print-app-fix-'));
    const { app, appServices } = makeFakeHarness();
    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({
      id: 'ses_other',
      workspaceId: 'wd_other',
      cwd: otherDir,
      environmentCwd: otherDir,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    const sessions = appServices.get(ISessionManager) as { resume: ReturnType<typeof vi.fn> };

    mocks.bootstrap.mockReturnValue({ app });

    try {
      await expect(
        runV2Print(opts({ session: 'ses_other' }) as never, '1.2.3-test', { stdout, stderr }),
      ).rejects.toThrow('Session "ses_other" was created under a different directory.');
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }

    expect(stderr.text()).toContain(`  cd "${otherDir}" && kimi -r ses_other`);
    expect(sessions.resume).not.toHaveBeenCalled();
  });

  it('refuses to resume a session from another project whose directory no longer exists and gives no cd hint', async () => {
    const stdout = writer();
    const stderr = writer();
    const removed = await mkdtemp(join(tmpdir(), 'kimi-print-removed-'));
    const missing = join(removed, 'app-fix');
    const { app, appServices } = makeFakeHarness();
    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({
      id: 'ses_gone',
      workspaceId: 'wd_other',
      cwd: missing,
      environmentCwd: missing,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    const sessions = appServices.get(ISessionManager) as { resume: ReturnType<typeof vi.fn> };

    mocks.bootstrap.mockReturnValue({ app });

    try {
      await expect(
        runV2Print(opts({ session: 'ses_gone' }) as never, '1.2.3-test', { stdout, stderr }),
      ).rejects.toThrow('Session "ses_gone" was created in a directory that no longer exists.');
    } finally {
      await rm(removed, { recursive: true, force: true });
    }

    expect(stderr.text()).toContain(`  ${missing}`);
    expect(stderr.text()).not.toContain('kimi -r');
    expect(sessions.resume).not.toHaveBeenCalled();
  });

  it('resumes a session whose Windows working directory differs only in case and separators', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();
    vi.spyOn(process, 'cwd').mockReturnValue('c:/work/app');
    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({
      id: 'ses_win',
      workspaceId: 'wd_v2',
      cwd: String.raw`C:\Work\App`,
      environmentCwd: String.raw`C:\Work\App`,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    const sessions = appServices.get(ISessionManager) as { resume: ReturnType<typeof vi.fn> };

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    try {
      await runV2Print(opts({ session: 'ses_win' }) as never, '1.2.3-test', { stdout, stderr });
    } finally {
      vi.mocked(process.cwd).mockRestore();
    }

    expect(stderr.text()).not.toContain('different directory');
    expect(sessions.resume.mock.calls.map(([id]) => id)).toEqual(['ses_win']);
  });

  it('says nothing about Plan mode when the resumed session is not in Plan mode', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices, appServices } = makeFakeHarness();

    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd() });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ session: 'ses_1' }) as never, '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).not.toContain('Plan mode');
    const loop = agentServices.get(IAgentLoopService) as { submit: ReturnType<typeof vi.fn> };
    expect(loop.submit).toHaveBeenCalledTimes(1);
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
      region: 'mainland-cn',
      regionSource: 'env',
      resolveRegion: expect.any(Function),
      endpoint: expect.any(Function),
      getAccessToken: expect.any(Function),
      onUnexpectedError: expect.any(Function),
    });
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

    const profile = agentServices.get(IAgentLoopService) as { getModel: () => string };
    profile.getModel = () => 'resumed-model';
    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd() });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts({ session: 'ses_1' }) as never, '1.2.3-test', { stdout, stderr });

    expect(mocks.initializeTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'k2' }),
    );
    expect(mocks.setTelemetryModel).toHaveBeenCalledWith('resumed-model');
    const auth = agentServices.get(IAuthSummaryService) as { ensureReady: ReturnType<typeof vi.fn> };
    expect(auth.ensureReady).toHaveBeenCalledWith('resumed-model');
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

    const promptService = agentServices.get(IAgentLoopService) as {
      promptHandle: ReturnType<typeof vi.fn>;
    };
    promptService.promptHandle.mockReturnValueOnce({
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

    const promptService = agentServices.get(IAgentLoopService) as {
      promptHandle: ReturnType<typeof vi.fn>;
    };
    promptService.promptHandle.mockReturnValueOnce({
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

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('cancels and settles the active turn before flushing on %s', async (signal, exitCode) => {
    const stdout = writer();
    const stderr = writer();
    const { app, agentServices } = makeFakeHarness();

    const order: string[] = [];
    const loop = agentServices.get(IAgentLoopService) as {
      snapshot: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      settled: ReturnType<typeof vi.fn>;
      tryAcquireQuiescence: ReturnType<typeof vi.fn>;
    };
    loop.snapshot.mockReturnValue({
      state: 'running',
      activeTurnId: undefined,
      activePromptId: undefined,
      queue: [],
      notificationCount: 0,
      paused: false,
      hasPendingRequests: false,
      turn: undefined,
      activeTraceId: undefined,
    });
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
      list: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    };
    taskService.list = vi.fn(() => [{ taskId: 'task-1' }]);
    taskService.stop = vi.fn(async () => {
      if (!order.includes('stop')) order.push('stop');
    });
    const dispatcher = agentServices.get(IEventDispatcher) as {
      flush: ReturnType<typeof vi.fn>;
    };
    dispatcher.flush = vi.fn(async () => {
      order.push('flush');
    });

    const promptService = agentServices.get(IAgentLoopService) as {
      promptHandle: ReturnType<typeof vi.fn>;
      snapshot: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
    };
    let settleTurn!: (result: unknown) => void;
    promptService.promptHandle.mockReturnValueOnce({
      launched: Promise.resolve({
        id: 1,
        result: new Promise((resolve) => {
          settleTurn = resolve;
        }),
      }),
    });
    let promptPhase: 'launching' | 'active' | 'empty' = 'launching';
    promptService.snapshot = vi.fn(() => {
      if (promptPhase === 'launching') {
        return {
          state: 'running',
          activeTurnId: undefined,
          activePromptId: undefined,
          queue: [{ id: 'p1', message: { role: 'user', content: [] } }],
          notificationCount: 0,
          paused: false,
          hasPendingRequests: true,
          turn: undefined,
          activeTraceId: undefined,
        };
      }
      if (promptPhase === 'active') {
        return {
          state: 'running',
          activeTurnId: 1,
          activePromptId: 'p1',
          queue: [],
          notificationCount: 0,
          paused: false,
          hasPendingRequests: false,
          turn: undefined,
          activeTraceId: undefined,
        };
      }
      return {
        state: 'idle',
        activeTurnId: undefined,
        activePromptId: undefined,
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: false,
        turn: undefined,
        activeTraceId: undefined,
      };
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
    for (let i = 0; i < 100 && !handlers.has(signal); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const onTermination = handlers.get(signal)!;
    settleTurn({ type: 'cancelled', steps: 0, reason: new Error('aborted') });
    const terminationRun = onTermination();
    for (let i = 0; i < 100 && !order.includes('settled'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(promptService.cancel).toHaveBeenCalled();
    expect(order).toEqual(['stop', 'cancel', 'settled']);
    promptPhase = 'active';
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(['stop', 'cancel', 'settled']);
    promptPhase = 'empty';
    await terminationRun;

    expect(order).toEqual(['stop', 'cancel', 'settled', 'flush', `exit:${exitCode}`]);
    expect(app.dispose).toHaveBeenCalledOnce();
    expect(loop.tryAcquireQuiescence).toHaveBeenCalled();
    const lastGuardRelease = guardDispose.mock.invocationCallOrder.at(-1);
    const appDisposeOrder = app.dispose.mock.invocationCallOrder[0];
    expect(lastGuardRelease).toBeGreaterThan(appDisposeOrder!);
    expect(await outcome).toBeInstanceOf(Error);
  });

  it('warns on stderr when workspace trust skips project-level MCP servers', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app } = makeFakeHarness();
    trustInfo.mockResolvedValue(gated(
      { name: 'api', transport: 'http', url: 'https://example.com/mcp', origin: '/tmp/project/.kimi-code/mcp.json' },
      { name: 'fs', transport: 'stdio', command: 'node', args: ['server.js'], origin: '/tmp/project/.mcp.json' },
      { name: 'github', transport: 'stdio', command: './project-github', origin: '/tmp/project/.mcp.json' },
    ));

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).toContain(
      'Warning: this project is not trusted; skipped 3 project-level MCP servers: ' +
        'api (http: https://example.com/mcp), fs (stdio: node server.js), github (stdio: ./project-github).',
    );
    expect(stderr.text()).toContain('"Trust and continue"');
    expect(stdout.text()).toContain('hello world');
  });

  it('stays silent when trusting would start no project-level MCP server', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    expect(stderr.text()).not.toContain('not trusted');
  });

  it('asks about the environment the new session is started on', async () => {
    const { app } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(
      opts({ environment: 'local', environmentCwd: 'src' }) as never,
      '1.2.3-test',
      { stdout: writer(), stderr: writer() },
    );

    expect(trustInfo.mock.calls).toEqual([
      [process.cwd(), { sessionId: undefined, environmentId: 'local', environmentCwd: 'src' }],
    ]);
  });

  describe('the trust warning of a resumed session', () => {
    const summary = (overrides: Record<string, unknown>) => ({
      id: 'ses_managed',
      workspaceId: 'wm_managed',
      cwd: process.cwd(),
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      ...overrides,
    });

    function untrustedHarness(target: ReturnType<typeof summary> | undefined) {
      const harness = makeFakeHarness();
      const index = harness.appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
      index.get.mockResolvedValue(target);
      const { get, resume } = harness.appServices.get(ISessionManager) as Record<'get' | 'resume', ReturnType<typeof vi.fn>>;
      get.mockReturnValueOnce(undefined);
      trustInfo.mockResolvedValue(gated({ name: 'fs', transport: 'stdio', command: 'node', origin: '/tmp/project/.mcp.json' }));
      mocks.bootstrap.mockReturnValue({ app: harness.app });
      mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });
      return { resume };
    }

    const askedAbout = () => trustInfo.mock.calls.map(([workDir, options]) => [workDir, options?.sessionId]);

    it.each([
      ['pinned at the startup directory', { environmentCwd: process.cwd() }],
      ['that follows the primary directory', {}],
      ['on another environment', { environmentId: 'box', environmentCwd: '/srv/project' }],
    ] as const)('is about the project of a session %s', async (_label, overrides) => {
      const stderr = writer();
      untrustedHarness(summary(overrides));

      await runV2Print(opts({ session: 'ses_managed' }) as never, '1.2.3-test', { stdout: writer(), stderr });

      expect(askedAbout()).toEqual([[process.cwd(), 'ses_managed']]);
      expect(stderr.text()).toContain('skipped 1 project-level MCP server: fs (stdio: node).');
    });

    it.each([
      ['does not exist', undefined, 'Session "ses_managed" not found.'],
      ['runs elsewhere', summary({ cwd: '/tmp/elsewhere', environmentCwd: '/tmp/elsewhere' }), 'Session "ses_managed" was created in a directory that no longer exists.'],
    ] as const)('is about the project of the startup directory when the session %s', async (_label, target, failure) => {
      untrustedHarness(target);

      await expect(
        runV2Print(opts({ session: 'ses_managed' }) as never, '1.2.3-test', { stdout: writer(), stderr: writer() }),
      ).rejects.toThrow(failure);

      expect(askedAbout()).toEqual([[process.cwd(), undefined]]);
    });

    it('is left out when the project of the session is gone and resuming reports it', async () => {
      const stderr = writer();
      const { resume } = untrustedHarness(summary({ environmentCwd: process.cwd() }));
      trustInfo.mockRejectedValue(new KimiError('session.not_found', 'Session "ses_managed" was not found.'));
      resume.mockRejectedValue(new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, 'session project wm_managed no longer exists'));

      await expect(
        runV2Print(opts({ session: 'ses_managed' }) as never, '1.2.3-test', { stdout: writer(), stderr }),
      ).rejects.toThrow('session project wm_managed no longer exists');

      expect(askedAbout()).toEqual([[process.cwd(), 'ses_managed']]);
      expect(stderr.text()).not.toContain('not trusted');
    });
  });

  it('still runs when the trust-gated MCP probe fails', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app } = makeFakeHarness();
    trustInfo.mockRejectedValue(new Error('trust store unavailable'));

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    expect(stdout.text()).toContain('hello world');
  });

  describe('worktree and same-project resume', () => {
    function sampleCreated(overrides: Partial<CreatedWorktree> = {}): CreatedWorktree {
      return {
        worktree: {
          path: '/tmp/home/worktrees/wd_repo/fix-login',
          name: 'fix-login',
          head: '1234567890abcdef',
          branch: undefined,
          missing: false,
          managed: true,
        },
        repoRoot: '/tmp/repo',
        sourceRoot: '/tmp/repo',
        cwd: '/tmp/home/worktrees/wd_repo/fix-login',
        cwdFallback: false,
        copiedFiles: ['.env'],
        sourceDirty: true,
        setupScript: undefined,
        ...overrides,
      };
    }

    it('rejects -w with OptionConflictError when the worktree flag is off', async () => {
      const { app } = makeFakeHarness();
      mocks.bootstrap.mockReturnValue({ app });

      await expect(
        runV2Print(opts({ worktree: 'fix-login' }) as never, '1.2.3-test', { stdout: writer(), stderr: writer() }),
      ).rejects.toThrow(OptionConflictError);
    });

    it('creates a worktree, runs trusted setup script, runs session in worktree cwd, and reports it', async () => {
      const stdout = writer();
      const stderr = writer();
      const { app, appServices } = makeFakeHarness();
      (appServices.get(IFlagService) as { enabled: ReturnType<typeof vi.fn> }).enabled.mockReturnValue(true);
      const created = sampleCreated({ setupScript: '/tmp/repo/.kimi-code/worktree-setup.sh' });
      const createWt = vi.spyOn(SDKRpcClientV2.prototype, 'createWorktree').mockResolvedValueOnce(created);
      const runSetup = vi
        .spyOn(SDKRpcClientV2.prototype, 'runWorktreeSetupScript')
        .mockImplementationOnce(async (_input, options) => {
          options?.onOutput?.('setup ok\n');
          return { exitCode: 0 };
        });
      const listWt = vi.spyOn(SDKRpcClientV2.prototype, 'listWorktrees').mockResolvedValueOnce({
        repoRoot: created.repoRoot,
        currentCheckoutRoot: created.repoRoot,
        bare: false,
        worktrees: [created.worktree],
      });
      mocks.bootstrap.mockReturnValue({ app });
      mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

      try {
        await runV2Print(opts({ worktree: 'fix-login', worktreeBase: 'v1' }) as never, '1.2.3-test', { stdout, stderr });

        expect(createWt).toHaveBeenCalledWith({ cwd: process.cwd(), name: 'fix-login', base: 'v1' });
        expect(runSetup).toHaveBeenCalledTimes(1);
        const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
        expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ workDir: created.cwd }));
        expect(stderr.text()).toContain('Copied 1 file from .worktreeinclude: .env');
        expect(stderr.text()).toContain('Uncommitted changes in /tmp/repo stay there.');
        expect(stderr.text()).not.toContain('git stash');
        expect(stderr.text()).toContain('setup ok\n');
        expect(stderr.text()).toContain('Worktree: /tmp/home/worktrees/wd_repo/fix-login (detached at 1234567)');
      } finally {
        createWt.mockRestore();
        runSetup.mockRestore();
        listWt.mockRestore();
      }
    });

    it('skips the setup script with a warning when the project is untrusted', async () => {
      const stdout = writer();
      const stderr = writer();
      const { app, appServices } = makeFakeHarness();
      (appServices.get(IFlagService) as { enabled: ReturnType<typeof vi.fn> }).enabled.mockReturnValue(true);
      (appServices.get(IProjectInstanceManager) as { acquire: ReturnType<typeof vi.fn> }).acquire.mockResolvedValueOnce({
        instance: { program: { trust: { get: vi.fn(async () => false) } } },
        dispose: vi.fn(),
      });
      const created = sampleCreated({ setupScript: '/tmp/repo/.kimi-code/worktree-setup.sh', copiedFiles: [], sourceDirty: false });
      const createWt = vi.spyOn(SDKRpcClientV2.prototype, 'createWorktree').mockResolvedValueOnce(created);
      const runSetup = vi.spyOn(SDKRpcClientV2.prototype, 'runWorktreeSetupScript');
      const listWt = vi.spyOn(SDKRpcClientV2.prototype, 'listWorktrees').mockResolvedValueOnce({
        repoRoot: created.repoRoot,
        currentCheckoutRoot: created.repoRoot,
        bare: false,
        worktrees: [created.worktree],
      });
      mocks.bootstrap.mockReturnValue({ app });
      mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

      try {
        await runV2Print(opts({ worktree: 'fix-login' }) as never, '1.2.3-test', { stdout, stderr });

        expect(runSetup).not.toHaveBeenCalled();
        expect(stderr.text()).toContain('this project is not trusted; skipped the worktree setup script');
        expect(stdout.text()).toContain('hello world');
      } finally {
        createWt.mockRestore();
        runSetup.mockRestore();
        listWt.mockRestore();
      }
    });

    it('auto-switches for -S in another directory of the same project, warns if missing, and rejects other projects', async () => {
      const existingOtherDir = await mkdtemp(join(tmpdir(), 'kimi-print-same-project-'));
      try {
        const { app, appServices } = makeFakeHarness();
        (appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> }).get.mockResolvedValue({
          id: 'ses_same',
          workspaceId: 'wd_v2',
          cwd: existingOtherDir,
        });
        mocks.bootstrap.mockReturnValue({ app });
        mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

        const stderrSame = writer();
        await runV2Print(opts({ session: 'ses_same' }) as never, '1.2.3-test', { stdout: writer(), stderr: stderrSame });
        expect(stderrSame.text()).toContain(`Switched to ${existingOtherDir} to resume this session.`);

        const missingDir = join(existingOtherDir, 'deleted');
        (appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> }).get.mockResolvedValue({
          id: 'ses_gone',
          workspaceId: 'wd_v2',
          cwd: missingDir,
        });
        const stderrGone = writer();
        await runV2Print(opts({ session: 'ses_gone' }) as never, '1.2.3-test', { stdout: writer(), stderr: stderrGone });
        expect(stderrGone.text()).toContain(`working directory "${missingDir}" no longer exists; continuing anyway.`);

        (appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> }).get.mockResolvedValue({
          id: 'ses_other_project',
          workspaceId: 'wd_different_project',
          cwd: existingOtherDir,
        });
        await expect(
          runV2Print(opts({ session: 'ses_other_project' }) as never, '1.2.3-test', { stdout: writer(), stderr: writer() }),
        ).rejects.toThrow('Session "ses_other_project" was created under a different directory.');
      } finally {
        await rm(existingOtherDir, { recursive: true, force: true });
      }
    });

    it('resolves relative --agent-file and --add-dir from the launch directory when creating a -w worktree', async () => {
      const launchDir = await mkdtemp(join(tmpdir(), 'kimi-print-agent-launch-'));
      const worktreeDir = await mkdtemp(join(tmpdir(), 'kimi-print-agent-wt-'));
      await writeFile(
        join(launchDir, 'local-reviewer.md'),
        '---\nname: local-reviewer\ndescription: Reviews code.\n---\n\nYou review code.\n',
      );
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(launchDir);
      const { app, appServices } = makeFakeHarness();
      (appServices.get(IFlagService) as { enabled: ReturnType<typeof vi.fn> }).enabled.mockReturnValue(true);
      const created = sampleCreated({
        repoRoot: launchDir,
        sourceRoot: launchDir,
        cwd: worktreeDir,
        worktree: {
          path: worktreeDir,
          name: 'fix-login',
          head: '1234567890abcdef',
          branch: undefined,
          missing: false,
          managed: true,
        },
        copiedFiles: [],
        sourceDirty: false,
      });
      const createWt = vi.spyOn(SDKRpcClientV2.prototype, 'createWorktree').mockResolvedValueOnce(created);
      const listWt = vi.spyOn(SDKRpcClientV2.prototype, 'listWorktrees').mockResolvedValueOnce({
        repoRoot: launchDir,
        currentCheckoutRoot: launchDir,
        bare: false,
        worktrees: [created.worktree],
      });
      mocks.bootstrap.mockReturnValue({ app });
      mocks.ensureMainAgent.mockResolvedValue({ agentId: 'main', generation: 1 });

      try {
        await runV2Print(
          opts({
            worktree: 'fix-login',
            agentFiles: ['./local-reviewer.md'],
            addDirs: ['../shared', '~/team-dir'],
          }) as never,
          '1.2.3-test',
          { stdout: writer(), stderr: writer() },
        );

        const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
        expect(sessions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            workDir: worktreeDir,
            additionalDirs: [normalize(join(launchDir, '..', 'shared')), '~/team-dir'],
            mainAgentBinding: { profile: 'local-reviewer', model: 'k2' },
          }),
        );
      } finally {
        createWt.mockRestore();
        listWt.mockRestore();
        cwd.mockRestore();
        await rm(launchDir, { recursive: true, force: true });
        await rm(worktreeDir, { recursive: true, force: true });
      }
    });
  });
});
