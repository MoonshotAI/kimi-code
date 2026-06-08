import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FLAG_DEFINITIONS,
  MASTER_ENV,
  createRPC,
  ErrorCodes,
  KimiCore,
  KimiError,
  type ApprovalResponse,
  type CoreAPI,
  type SDKAPI,
} from '../../src';
import {
  __resetRootLoggerForTest,
  getRootLogger,
  resolveGlobalLogPath,
} from '../../src/logging/logger';
import { resolveLoggingConfig } from '../../src/logging/resolve-config';
import type { OAuthTokenProviderResolver } from '../../src/session/provider-manager';
import { testKaos } from '../fixtures/test-kaos';

function requiredFlagEnv(id: string): string {
  const def = FLAG_DEFINITIONS.find((item) => item.id === id);
  if (def === undefined) throw new Error(`Missing flag definition: ${id}`);
  return def.env;
}

function clearExperimentalEnv(): void {
  vi.stubEnv(MASTER_ENV, '0');
  for (const def of FLAG_DEFINITIONS) {
    vi.stubEnv(def.env, '');
  }
}

function experimentalFeatureEnabled(core: KimiCore, id: string): boolean | undefined {
  return core.getExperimentalFeatures().find((feature) => feature.id === id)?.enabled;
}

function setCoreKaos(core: KimiCore, kaos: Promise<Kaos>): void {
  (core as unknown as { kaos?: Promise<Kaos> }).kaos = kaos;
}

function rejectedKaos(error: Error): Promise<Kaos> {
  const promise = Promise.reject(error) as Promise<Kaos>;
  promise.catch(() => undefined);
  return promise;
}

describe('KimiCore runtime config', () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp !== undefined) {
      await rm(tmp, { recursive: true, force: true });
    }
    await __resetRootLoggerForTest();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('logs all enabled experimental flags once on core startup', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    await mkdir(homeDir, { recursive: true });
    await getRootLogger().configure(resolveLoggingConfig({ homeDir }));

    vi.stubEnv(MASTER_ENV, '0');
    for (const def of FLAG_DEFINITIONS) {
      vi.stubEnv(def.env, '0');
    }
    vi.stubEnv(requiredFlagEnv('goal_command'), '1');
    vi.stubEnv(requiredFlagEnv('background_ask'), '1');

    void new KimiCore(async () => ({}) as never, { homeDir });
    await getRootLogger().flushGlobal();

    const text = await readFile(resolveGlobalLogPath(homeDir), 'utf-8');
    expect(text).toContain('experimental flags enabled');
    expect(text).toContain('goal_command');
    expect(text).toContain('background_ask');
    expect(text.match(/experimental flags enabled/g)).toHaveLength(1);
  });

  it('resolves experimental flags from each core config independently', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const firstHome = join(tmp, 'first-home');
    const secondHome = join(tmp, 'second-home');
    await mkdir(firstHome, { recursive: true });
    await mkdir(secondHome, { recursive: true });
    await writeFile(
      join(firstHome, 'config.toml'),
      `
[experimental]
goal_command = true
background_ask = false
`,
    );
    await writeFile(
      join(secondHome, 'config.toml'),
      `
[experimental]
goal_command = false
background_ask = true
`,
    );
    clearExperimentalEnv();

    const first = new KimiCore(async () => ({}) as never, { homeDir: firstHome });
    const second = new KimiCore(async () => ({}) as never, { homeDir: secondHome });

    expect(experimentalFeatureEnabled(first, 'goal_command')).toBe(true);
    expect(experimentalFeatureEnabled(first, 'background_ask')).toBe(false);
    expect(experimentalFeatureEnabled(second, 'goal_command')).toBe(false);
    expect(experimentalFeatureEnabled(second, 'background_ask')).toBe(true);
  });

  it('updates the scoped experimental resolver after setKimiConfig', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[experimental]
goal_command = false
`,
    );
    clearExperimentalEnv();

    const core = new KimiCore(async () => ({}) as never, { homeDir });
    expect(experimentalFeatureEnabled(core, 'goal_command')).toBe(false);

    await core.setKimiConfig({
      experimental: {
        'goal_command': true,
      },
    });

    expect(experimentalFeatureEnabled(core, 'goal_command')).toBe(true);
  });

  it('updates the shared experimental resolver without hot-refreshing materialized tools', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `${baseModelConfig()}
[experimental]
goal_command = false
`,
    );
    clearExperimentalEnv();

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_experimental_refresh',
      workDir,
      model: 'default-mock',
    });
    const session = core.sessions.get(created.id);
    const mainAgent = session?.getReadyAgent('main');

    expect(session?.experimentalFlags.enabled('goal_command')).toBe(false);
    expect(mainAgent?.experimentalFlags.enabled('goal_command')).toBe(false);
    expect(mainAgent?.tools.data().some((tool) => tool.name === 'CreateGoal')).toBe(false);

    await core.setKimiConfig({
      experimental: {
        'goal_command': true,
      },
    });

    expect(session?.experimentalFlags.enabled('goal_command')).toBe(true);
    expect(mainAgent?.experimentalFlags.enabled('goal_command')).toBe(true);
    expect(mainAgent?.tools.data().some((tool) => tool.name === 'CreateGoal')).toBe(false);

    await rpc.reloadSession({ sessionId: created.id });
    const reloadedMainAgent = core.sessions.get(created.id)?.getReadyAgent('main');
    expect(reloadedMainAgent?.tools.data().some((tool) => tool.name === 'CreateGoal')).toBe(true);
  });

  it('uses the shared OAuth resolver for Moonshot service tokens', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[services.moonshot_search]
base_url = "https://search.example/v1"
oauth = { storage = "file", key = "oauth/custom-kimi-code" }
custom_headers = { "X-Test" = "1" }
`,
    );

    const getAccessToken = vi.fn().mockResolvedValue('service-token');
    const resolveOAuthTokenProvider = vi.fn<OAuthTokenProviderResolver>(() => ({
      getAccessToken,
    }));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ search_results: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, {
      homeDir,
      kimiRequestHeaders: {
        'User-Agent': 'kimi-code-cli/0.0.0-test',
        'X-Msh-Version': '0.0.0-test',
      },
      resolveOAuthTokenProvider,
    });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({ id: 'ses_runtime_service_oauth', workDir });
    const session = core.sessions.get(created.id);

    expect(resolveOAuthTokenProvider).toHaveBeenCalledWith('managed:kimi-code', {
      storage: 'file',
      key: 'oauth/custom-kimi-code',
    });
    expect(session?.options.toolServices?.webSearcher).toBeDefined();

    await session!.options.toolServices?.webSearcher!.search('kimi');

    expect(getAccessToken).toHaveBeenCalledWith();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer service-token',
      'User-Agent': 'kimi-code-cli/0.0.0-test',
      'X-Msh-Version': '0.0.0-test',
      'X-Test': '1',
    });
  });

  it('falls back to defaultModel when createSession receives no model option', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `default_model = "default-mock"

[providers.test]
type = "kimi"
api_key = "test-key"

[models."default-mock"]
provider = "test"
model = "default-mock"
max_context_size = 100000
`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({ id: 'ses_runtime_default_model', workDir });
    const session = core.sessions.get(created.id);
    const mainAgent = session?.getReadyAgent('main');

    expect(mainAgent?.config.modelAlias).toBe('default-mock');
  });

  it('rejects createSession when shell runtime initialization fails', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    setCoreKaos(
      core,
      rejectedKaos(
        new KimiError(ErrorCodes.SHELL_GIT_BASH_NOT_FOUND, 'Git Bash missing'),
      ),
    );

    await expect(
      rpc.createSession({
        id: 'ses_runtime_shell_missing_create',
        workDir,
        model: 'default-mock',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.SHELL_GIT_BASH_NOT_FOUND });
    expect(core.sessions.has('ses_runtime_shell_missing_create')).toBe(false);
  });

  it('rejects resumeSession when shell runtime initialization fails', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    setCoreKaos(core, Promise.resolve(testKaos));
    const created = await rpc.createSession({
      id: 'ses_runtime_shell_missing_resume',
      workDir,
      model: 'default-mock',
    });
    await rpc.closeSession({ sessionId: created.id });
    setCoreKaos(
      core,
      rejectedKaos(
        new KimiError(ErrorCodes.SHELL_GIT_BASH_NOT_FOUND, 'Git Bash missing'),
      ),
    );

    await expect(rpc.resumeSession({ sessionId: created.id })).rejects.toMatchObject({
      code: ErrorCodes.SHELL_GIT_BASH_NOT_FOUND,
    });
    expect(core.sessions.has(created.id)).toBe(false);
  });

  it('reloads an active session with fresh runtime services from config.toml', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const configPath = join(homeDir, 'config.toml');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, baseModelConfig());

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_reload',
      workDir,
      model: 'default-mock',
    });
    const before = core.sessions.get(created.id);
    expect(before?.options.toolServices?.webSearcher).toBeUndefined();

    await writeFile(
      configPath,
      `${baseModelConfig()}
[services.moonshot_search]
base_url = "https://search.example.test/v1"
`,
    );

    const reloaded = await rpc.reloadSession({ sessionId: created.id });
    const after = core.sessions.get(created.id);

    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(after?.options.toolServices?.webSearcher).toBeDefined();
    expect(reloaded.agents['main']).toBeDefined();
  });

  it('rejects reloadSession while the active session has a running turn', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_reload_busy',
      workDir,
      model: 'default-mock',
    });
    const active = core.sessions.get(created.id);
    const main = active?.getReadyAgent('main');
    vi.spyOn(main!.turn, 'hasActiveTurn', 'get').mockReturnValue(true);

    await expect(rpc.reloadSession({ sessionId: created.id })).rejects.toMatchObject({
      code: ErrorCodes.TURN_AGENT_BUSY,
    });
    expect(core.sessions.get(created.id)).toBe(active);
  });
});

function baseModelConfig(): string {
  return `default_model = "default-mock"

[providers.test]
type = "kimi"
api_key = "test-key"

[models."default-mock"]
provider = "test"
model = "default-mock"
max_context_size = 100000
`;
}
