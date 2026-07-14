import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IFileSystemStorageService,
  IOAuthToolkit,
  ISessionIndex,
  ISessionLifecycleService,
  ISkillCatalogRuntimeOptions,
  ITelemetryService,
  type DomainEvent,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';

import { runV2Print } from '../../src/cli/v2/run-v2-print';

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  ensureMainAgent: vi.fn(),
  createKimiDefaultHeaders: vi.fn(() => ({})),
  resolveKimiHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home'),
  createKimiDeviceId: vi.fn(() => 'device-1'),
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

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: vi.fn(),
  setCrashPhase: vi.fn(),
  shutdownTelemetry: vi.fn(),
  track: vi.fn(),
  setTelemetryContext: vi.fn(),
  withTelemetryContext: vi.fn(() => ({ track: vi.fn() })),
}));

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
    addDirs: [],
    ...overrides,
  } as const;
}

function makeFakeHarness() {
  // Native event listeners registered on the main agent's IEventBus; the turn
  // emits a streaming assistant delta before completing.
  const eventListeners = new Set<(event: DomainEvent) => void>();

  const agentServices = new Map<unknown, unknown>([
    [IAgentProfileService, { setModel: vi.fn(async () => ({ model: 'k2' })), getModel: () => 'k2' }],
    [IAgentPermissionModeService, { mode: 'auto', setMode: vi.fn() }],
    [IAuthSummaryService, { ensureReady: vi.fn(async () => {}) }],
    [
      IEventBus,
      {
        subscribe: vi.fn((handler: (event: DomainEvent) => void) => {
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
            listener({ type: 'assistant.delta', turnId: 1, delta: 'hello world' } as DomainEvent);
          }
          return {
            launched: Promise.resolve({
              id: 1,
              result: Promise.resolve({ type: 'completed' }),
            }),
          };
        }),
      },
    ],
    [IAgentTaskService, { list: vi.fn(() => []) }],
    [IAgentGoalService, { createGoal: vi.fn(), getGoal: vi.fn() }],
  ]);
  const agent = fakeScope('main', agentServices);

  const sessionServices = new Map<unknown, unknown>([
    // drain enumerates agents; empty → no background work to wait on.
    [IAgentLifecycleService, { list: vi.fn(() => []) }],
  ]);
  const session = fakeScope('ses_v2', sessionServices);

  const appServices = new Map<unknown, unknown>([
    [
      IConfigService,
      {
        ready: Promise.resolve(),
        get: vi.fn((section: string) => (section === 'defaultModel' ? 'k2' : undefined)),
        diagnostics: vi.fn(() => []),
      },
    ],
    [
      ISessionLifecycleService,
      {
        create: vi.fn(async () => session),
        resume: vi.fn(async () => session),
      },
    ],
    [ISessionIndex, { list: vi.fn(async () => ({ items: [] })) }],
    [
      IBootstrapService,
      {
        platform: 'linux',
        arch: 'x64',
        clientVersion: '1.2.3-test',
        getEnv: () => undefined,
      },
    ],
    [IOAuthToolkit, { getCachedAccessToken: vi.fn(async () => undefined) }],
    [IFileSystemStorageService, {}],
    [
      ITelemetryService,
      (() => {
        const svc = {
          setAppender: vi.fn(),
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
  return { app, agent, session, agentServices };
}

describe('runV2Print', () => {
  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
    vi.stubEnv('KIMI_MODEL_OUTPUT_FORMAT', '');
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
    mocks.ensureMainAgent.mockResolvedValue(agent);

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

  it('seeds explicit skill dirs from --skillsDir into bootstrap', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts({ skillsDirs: ['/skills'] }) as never, '1.2.3-test', {
      stdout,
      stderr,
    });

    const seeds = mocks.bootstrap.mock.calls[0]?.[1] as ScopeSeed;
    const seeded = seeds.find(([id]) => id === ISkillCatalogRuntimeOptions);
    expect(seeded?.[1]).toMatchObject({ explicitDirs: ['/skills'] });
  });

  it('leaves the skill runtime options unseeded when --skillsDir is empty', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const seeds = mocks.bootstrap.mock.calls[0]?.[1] as ScopeSeed;
    expect(seeds.some(([id]) => id === ISkillCatalogRuntimeOptions)).toBe(false);
  });
});
