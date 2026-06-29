import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'pathe';

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

// Builds a Kaos that behaves like the ACP reverse-RPC bridge during
// `session/new`: reading a `local.toml` rejects with a non-ENOENT error because
// the client does not know the session yet (issue #988). Everything else
// delegates to the underlying kaos, so once the system-file read is routed
// through a working (local) kaos, session bootstrap can still proceed.
function createLocalTomlFailingKaos(base: Kaos): Kaos {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'readText') {
        return (
          path: string,
          options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
        ) => {
          if (String(path).endsWith('local.toml')) {
            return Promise.reject(
              new Error(`acp: readTextFile failed for ${path}: unknown session (issue #988)`),
            );
          }
          return target.readText(path, options);
        };
      }
      if (prop === 'withCwd') {
        return (cwd: string) => createLocalTomlFailingKaos(target.withCwd(cwd));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
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
    vi.stubEnv(requiredFlagEnv('micro_compaction'), '1');

    void new KimiCore(async () => ({}) as never, { homeDir });
    await getRootLogger().flushGlobal();

    const text = await readFile(resolveGlobalLogPath(homeDir), 'utf-8');
    expect(text).toContain('experimental flags enabled');
    expect(text).toContain('micro_compaction');
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
micro_compaction = true
`,
    );
    await writeFile(
      join(secondHome, 'config.toml'),
      `
[experimental]
micro_compaction = false
`,
    );
    clearExperimentalEnv();

    const first = new KimiCore(async () => ({}) as never, { homeDir: firstHome });
    const second = new KimiCore(async () => ({}) as never, { homeDir: secondHome });

    expect(experimentalFeatureEnabled(first, 'micro_compaction')).toBe(true);
    expect(experimentalFeatureEnabled(second, 'micro_compaction')).toBe(false);
  });

  it('updates the scoped experimental resolver after setKimiConfig', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[experimental]
micro_compaction = false
`,
    );
    clearExperimentalEnv();

    const core = new KimiCore(async () => ({}) as never, { homeDir });
    expect(experimentalFeatureEnabled(core, 'micro_compaction')).toBe(false);

    await core.setKimiConfig({
      experimental: {
        'micro_compaction': true,
      },
    });

    expect(experimentalFeatureEnabled(core, 'micro_compaction')).toBe(true);
  });

  it('updates the shared experimental resolver while goal tools stay available', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(homeDir, 'config.toml'),
      `${baseModelConfig()}
[experimental]
micro_compaction = false
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

    expect(session?.experimentalFlags.enabled('micro_compaction')).toBe(false);
    expect(mainAgent?.experimentalFlags.enabled('micro_compaction')).toBe(false);
    expect(mainAgent?.tools.data().some((tool) => tool.name === 'CreateGoal')).toBe(true);

    await core.setKimiConfig({
      experimental: {
        'micro_compaction': true,
      },
    });

    expect(session?.experimentalFlags.enabled('micro_compaction')).toBe(true);
    expect(mainAgent?.experimentalFlags.enabled('micro_compaction')).toBe(true);
    expect(mainAgent?.tools.data().some((tool) => tool.name === 'CreateGoal')).toBe(true);

    await rpc.reloadSession({ sessionId: created.id });
    const reloadedMainAgent = core.sessions.get(created.id)?.getReadyAgent('main');
    expect(reloadedMainAgent?.tools.data().some((tool) => tool.name === 'CreateGoal')).toBe(true);
  });

  // Regression for https://github.com/MoonshotAI/kimi-code/issues/988: during
  // ACP `session/new` the tool kaos is the reverse-RPC bridge and the client
  // does not know the session yet, so reading `.kimi-code/local.toml` through
  // it rejects. The workspace local config is a local system file and must be
  // read through the persistence (local) kaos instead.
  it('reads workspace local.toml through persistenceKaos during createSession', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const sharedDir = join(tmp, 'shared');
    await mkdir(homeDir, { recursive: true });
    await mkdir(join(workDir, '.git'), { recursive: true });
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["../shared"]\n`,
    );
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await core.createSessionWithOverrides(
      { id: 'ses_runtime_local_toml_bootstrap', workDir, model: 'default-mock' },
      { kaos: createLocalTomlFailingKaos(testKaos), persistenceKaos: testKaos },
    );

    const session = core.sessions.get(created.id);
    expect(session).toBeDefined();
    expect(session?.getAdditionalDirs()).toContain(normalize(sharedDir));
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

  it('loads project local additional dirs into the session and main agent', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const extraDir = join(workDir, 'extra');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(extraDir, { recursive: true });
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["extra"]\n`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_additional_dirs',
      workDir,
      model: 'default-mock',
    });
    const session = core.sessions.get(created.id);
    const mainAgent = session?.getReadyAgent('main');

    expect(created.additionalDirs).toEqual([extraDir]);
    expect(session?.getAdditionalDirs()).toEqual([extraDir]);
    expect(mainAgent?.getAdditionalDirs()).toEqual([extraDir]);
    expect(mainAgent?.config.systemPrompt).toContain('## Additional Directories');
    expect(mainAgent?.config.systemPrompt).toContain(extraDir);
  });

  it('returns additionalDirs when resuming an active session', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const extraDir = join(workDir, 'extra');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(extraDir, { recursive: true });
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["extra"]\n`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_additional_dirs_active_resume',
      workDir,
      model: 'default-mock',
    });
    const resumed = await rpc.resumeSession({ sessionId: created.id });

    expect(resumed.additionalDirs).toEqual([extraDir]);
    expect(core.sessions.get(created.id)?.getAdditionalDirs()).toEqual([extraDir]);
  });

  it('returns additionalDirs when resuming a closed session', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const extraDir = join(workDir, 'extra');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(extraDir, { recursive: true });
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["extra"]\n`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_additional_dirs_closed_resume',
      workDir,
      model: 'default-mock',
    });
    await rpc.closeSession({ sessionId: created.id });

    const resumed = await rpc.resumeSession({ sessionId: created.id });
    const session = core.sessions.get(created.id);
    const mainAgent = session?.getReadyAgent('main');

    expect(resumed.additionalDirs).toEqual([extraDir]);
    expect(session?.getAdditionalDirs()).toEqual([extraDir]);
    expect(mainAgent?.getAdditionalDirs()).toEqual([extraDir]);
  });

  it('merges caller additionalDirs when resuming a closed session', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const localDir = join(workDir, 'local');
    const callerDir = join(workDir, 'caller');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await mkdir(callerDir, { recursive: true });
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["local"]\n`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_additional_dirs_resume_caller',
      workDir,
      model: 'default-mock',
    });
    await rpc.closeSession({ sessionId: created.id });

    const resumed = await rpc.resumeSession({
      sessionId: created.id,
      additionalDirs: ['caller'],
    });
    const session = core.sessions.get(created.id);
    const mainAgent = session?.getReadyAgent('main');

    expect(resumed.additionalDirs).toEqual([localDir, callerDir]);
    expect(session?.getAdditionalDirs()).toEqual([localDir, callerDir]);
    expect(mainAgent?.getAdditionalDirs()).toEqual([localDir, callerDir]);
  });

  it('deduplicates project local and caller relative additionalDirs after resolving them', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const sharedDir = join(workDir, 'shared');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["shared"]\n`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_additional_dirs_dedupe',
      workDir,
      model: 'default-mock',
      additionalDirs: ['shared'],
    });

    expect(created.additionalDirs).toEqual([sharedDir]);
    expect(core.sessions.get(created.id)?.getAdditionalDirs()).toEqual([sharedDir]);
  });

  it('supports multiple project local and caller additionalDirs', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const localDir = join(workDir, 'shared');
    const callerDir = join(workDir, 'other');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await mkdir(callerDir, { recursive: true });
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeFile(
      join(workDir, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["shared"]\n`,
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    void new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    const created = await rpc.createSession({
      id: 'ses_runtime_additional_dirs_multiple',
      workDir,
      model: 'default-mock',
      additionalDirs: ['other'],
    });

    expect(created.additionalDirs).toEqual([localDir, callerDir]);
  });

  it('resolves caller relative additionalDirs against workDir rather than projectRoot', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const projectRoot = join(tmp, 'repo');
    const workDir = join(projectRoot, 'apps', 'foo');
    const sharedDir = join(workDir, 'shared');
    await mkdir(homeDir, { recursive: true });
    await mkdir(join(projectRoot, '.git'), { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
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
      id: 'ses_runtime_additional_dirs_workdir_relative',
      workDir,
      model: 'default-mock',
      additionalDirs: ['shared'],
    });

    expect(created.additionalDirs).toEqual([sharedDir]);
    expect(core.sessions.get(created.id)?.getAdditionalDirs()).toEqual([sharedDir]);
  });

  it('records a local-command-stdout message when adding a remembered dir', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const extraDir = join(workDir, 'extra');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(extraDir, { recursive: true });
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
      id: 'ses_runtime_add_additional_dir_record',
      workDir,
      model: 'default-mock',
    });

    await rpc.addAdditionalDir({
      sessionId: created.id,
      path: 'extra',
      persist: true,
    });
    await core.sessions.get(created.id)?.getReadyAgent('main')?.records.flush();

    const records = await readMainWire(created.sessionDir);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'context.append_message',
        message: expect.objectContaining({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<local-command-stdout>\nAdded workspace directory:\n  extra\n  Saved to:\n  ${join(workDir, '.kimi-code', 'local.toml')}\n</local-command-stdout>`,
            },
          ],
          origin: { kind: 'injection', variant: 'local-command-stdout' },
        }),
      }),
    );
    expect(core.sessions.get(created.id)?.getReadyAgent('main')?.getAdditionalDirs()).toEqual([
      extraDir,
    ]);
  });

  it('adds an additional dir through the session RPC', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const extraDir = join(workDir, 'extra');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(extraDir, { recursive: true });
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
      id: 'ses_runtime_add_additional_dir',
      workDir,
      model: 'default-mock',
    });

    const result = await rpc.addAdditionalDir({
      sessionId: created.id,
      path: 'extra',
      persist: true,
    });
    const localToml = await readFile(join(workDir, '.kimi-code', 'local.toml'), 'utf-8');
    const session = core.sessions.get(created.id);
    const mainAgent = session?.getReadyAgent('main');

    expect(result).toMatchObject({
      additionalDirs: [extraDir],
      projectRoot: workDir,
      configPath: join(workDir, '.kimi-code', 'local.toml'),
      persisted: true,
    });
    expect(localToml).toContain('additional_dir = [');
    expect(session?.getAdditionalDirs()).toEqual([extraDir]);
    expect(mainAgent?.getAdditionalDirs()).toEqual([extraDir]);
  });

  it('adds a session-only additional dir without writing local.toml', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const extraDir = join(workDir, 'extra');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(extraDir, { recursive: true });
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
      id: 'ses_runtime_add_session_only_dir',
      workDir,
      model: 'default-mock',
    });

    const result = await rpc.addAdditionalDir({
      sessionId: created.id,
      path: 'extra',
      persist: false,
    });
    await core.sessions.get(created.id)?.getReadyAgent('main')?.records.flush();
    const records = await readMainWire(created.sessionDir);

    expect(result).toMatchObject({
      additionalDirs: [extraDir],
      projectRoot: workDir,
      configPath: join(workDir, '.kimi-code', 'local.toml'),
      persisted: false,
    });
    expect(core.sessions.get(created.id)?.getAdditionalDirs()).toEqual([extraDir]);
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'context.append_message',
        message: expect.objectContaining({
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<local-command-stdout>\nAdded workspace directory:\n  extra\n  For this session only\n</local-command-stdout>',
            },
          ],
          origin: { kind: 'injection', variant: 'local-command-stdout' },
        }),
      }),
    );
    await expect(readFile(join(workDir, '.kimi-code', 'local.toml'), 'utf-8')).rejects.toThrow();
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

  it('appends a fresh plugin_session_start reminder on forced reload', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const pluginRoot = join(tmp, 'plugin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeSessionStartPlugin(pluginRoot, 'OLD BODY');

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({
      id: 'ses_runtime_reload_reminder',
      workDir,
      model: 'default-mock',
    });

    // Before any forced reload the model has not been told about the plugin yet
    // (no turn has run, so the turn-loop injector has not fired).
    expect(pluginSessionStartReminders(core, created.id)).toHaveLength(0);

    // Update the skill content on disk so the reload must pick up the new body.
    // Preserve the SKILL.md frontmatter — the parser requires it to register the skill.
    await writeFile(
      managedSkillPath(homeDir),
      `---\nname: greeter\ndescription: A greeter skill\n---\nNEW BODY\n`,
    );

    const reloaded = await rpc.reloadSession({
      sessionId: created.id,
      forcePluginSessionStartReminder: true,
    });

    const reminders = pluginSessionStartReminders(core, created.id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain('<plugin_session_start plugin="demo" skill="greeter">');
    expect(reminders[0]).toContain('NEW BODY');
    expect(reminders[0]).not.toContain('OLD BODY');
    expect(reminders[0]).toContain('supersedes any earlier plugin_session_start');

    // The returned ResumeSessionResult must already include the fresh reminder
    // (otherwise SDK callers reading getResumeState() see stale plugin context).
    const resultReminders = remindersFromHistory(
      reloaded.agents['main']?.context.history ?? [],
    );
    expect(resultReminders).toHaveLength(1);
    expect(resultReminders[0]).toContain('NEW BODY');
  });

  it('neutralizes a stale plugin_session_start reminder when the plugin is removed', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const pluginRoot = join(tmp, 'plugin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeSessionStartPlugin(pluginRoot, 'BODY');

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({
      id: 'ses_runtime_reload_neutralize',
      workDir,
      model: 'default-mock',
    });

    // First forced reload appends an active reminder, establishing a prior
    // plugin_session_start in history.
    await rpc.reloadSession({
      sessionId: created.id,
      forcePluginSessionStartReminder: true,
    });
    expect(pluginSessionStartReminders(core, created.id)).toHaveLength(1);

    // Removing the plugin means no sessionStart is resolvable on the next reload;
    // the stale reminder must be neutralized rather than left in place.
    await core.removePlugin({ id: 'demo' });
    await rpc.reloadSession({
      sessionId: created.id,
      forcePluginSessionStartReminder: true,
    });

    const reminders = pluginSessionStartReminders(core, created.id);
    expect(reminders).toHaveLength(2);
    expect(reminders.at(-1)).toContain('no active plugin session starts');
    expect(reminders.at(-1)).toContain('supersedes any earlier plugin_session_start');
  });

  it('does not append a plugin_session_start reminder on reload without the force flag', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const pluginRoot = join(tmp, 'plugin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await writeSessionStartPlugin(pluginRoot, 'BODY');

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({
      id: 'ses_runtime_reload_no_force',
      workDir,
      model: 'default-mock',
    });

    await rpc.reloadSession({ sessionId: created.id });

    expect(pluginSessionStartReminders(core, created.id)).toHaveLength(0);
  });

  it('appends nothing on forced reload when no plugin declares a sessionStart', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-runtime-'));
    const homeDir = join(tmp, 'home');
    const workDir = join(tmp, 'work');
    const pluginRoot = join(tmp, 'plugin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(join(homeDir, 'config.toml'), baseModelConfig());
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
    );

    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });

    await core.installPlugin({ source: pluginRoot });
    const created = await rpc.createSession({
      id: 'ses_runtime_reload_no_sessionstart',
      workDir,
      model: 'default-mock',
    });

    await rpc.reloadSession({
      sessionId: created.id,
      forcePluginSessionStartReminder: true,
    });

    expect(pluginSessionStartReminders(core, created.id)).toHaveLength(0);
  });

  it('neutralizes stale plugin guidance after compaction when no sessionStart is active', async () => {
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
      id: 'ses_runtime_reload_compacted',
      workDir,
      model: 'default-mock',
    });
    const session = core.sessions.get(created.id);
    const main = session?.getReadyAgent('main');

    // Simulate a compaction that folded earlier messages (and any plugin guidance)
    // into a single summary, leaving no discrete plugin_session_start behind.
    main?.context.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'summary of earlier conversation with plugin guidance' }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    });

    await session?.appendPluginSessionStartReminder();

    const reminders = pluginSessionStartReminders(core, created.id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain('no active plugin session starts');
  });
});

async function writeSessionStartPlugin(root: string, skillBody: string): Promise<void> {
  await mkdir(join(root, 'skills', 'greeter'), { recursive: true });
  await writeFile(
    join(root, 'kimi.plugin.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      skills: ['./skills'],
      sessionStart: { skill: 'greeter' },
    }),
  );
  await writeFile(
    join(root, 'skills', 'greeter', 'SKILL.md'),
    `---\nname: greeter\ndescription: A greeter skill\n---\n${skillBody}\n`,
  );
}

function managedSkillPath(homeDir: string): string {
  return join(homeDir, 'plugins', 'managed', 'demo', 'skills', 'greeter', 'SKILL.md');
}

function pluginSessionStartReminders(core: KimiCore, sessionId: string): string[] {
  const agent = core.sessions.get(sessionId)?.getReadyAgent('main');
  if (agent === undefined) return [];
  return remindersFromHistory(agent.context.history);
}

function remindersFromHistory(
  history: ReadonlyArray<{
    role: string;
    origin?: { kind: string; variant?: string };
    content: ReadonlyArray<{ type: string; text?: string }>;
  }>,
): string[] {
  return history
    .filter(
      (message) =>
        message.role === 'user' &&
        message.origin?.kind === 'injection' &&
        message.origin.variant === 'plugin_session_start',
    )
    .map((message) => message.content.map((part) => part.text ?? '').join(''));
}

async function readMainWire(sessionDir: string): Promise<readonly Record<string, unknown>[]> {
  const wire = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
  return wire
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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
