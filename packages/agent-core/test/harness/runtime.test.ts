import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  ErrorCodes,
  KimiCore,
  type ApprovalResponse,
  type CoreAPI,
  type SDKAPI,
} from '../../src';
import type { OAuthTokenProviderResolver } from '../../src/session/provider-manager';

describe('KimiCore runtime config', () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp !== undefined) {
      await rm(tmp, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
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
    const mainAgent = session?.agents.get('main');

    expect(mainAgent?.config.modelAlias).toBe('default-mock');
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
    const main = active?.agents.get('main');
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
