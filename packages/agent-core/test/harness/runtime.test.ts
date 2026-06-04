import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FLAG_DEFINITIONS,
  MASTER_ENV,
  createRPC,
  KimiCore,
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

function requiredFlagEnv(id: string): string {
  const def = FLAG_DEFINITIONS.find((item) => item.id === id);
  if (def === undefined) throw new Error(`Missing flag definition: ${id}`);
  return def.env;
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
    vi.stubEnv(requiredFlagEnv('goal-command'), '1');
    vi.stubEnv(requiredFlagEnv('background-ask'), '1');

    void new KimiCore(async () => ({}) as never, { homeDir });
    await getRootLogger().flushGlobal();

    const text = await readFile(resolveGlobalLogPath(homeDir), 'utf-8');
    expect(text).toContain('experimental flags enabled');
    expect(text).toContain('goal-command');
    expect(text).toContain('background-ask');
    expect(text.match(/experimental flags enabled/g)).toHaveLength(1);
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
});
