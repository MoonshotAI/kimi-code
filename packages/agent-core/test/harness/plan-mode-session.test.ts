import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRPC, KimiCore, type CoreAPI, type SDKAPI } from '../../src';

const BASE_CONFIG = `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
api_key = "test-key"
base_url = "https://api.example/v1"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 1000000
`;

describe('plan-mode bootstrap from config.defaultPlanMode', () => {
  let tmp: string;
  let homeDir: string;
  let workDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-plan-mode-'));
    homeDir = join(tmp, 'home');
    workDir = join(tmp, 'work');
    configPath = join(tmp, 'config.toml');
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('activates plan mode on a new session when config.defaultPlanMode is true', async () => {
    await writeFile(configPath, `default_plan_mode = true\n${BASE_CONFIG}`);
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });
    await rpc.closeSession({ sessionId: created.id });

    expect(await countPlanModeEnters()).toBe(1);
  });

  it('leaves plan mode inactive when config.defaultPlanMode is absent', async () => {
    await writeFile(configPath, BASE_CONFIG);
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });
    await rpc.closeSession({ sessionId: created.id });

    expect(await countPlanModeEnters()).toBe(0);
  });

  it('does not apply config.defaultPlanMode when resuming an existing session', async () => {
    await writeFile(configPath, BASE_CONFIG);
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });
    await rpc.closeSession({ sessionId: created.id });

    // Turning the default on after the session already exists must not
    // retroactively push a resumed session into plan mode.
    await writeFile(configPath, `default_plan_mode = true\n${BASE_CONFIG}`);
    const freshRpc = await createTestRpc();
    await freshRpc.resumeSession({ sessionId: created.id });
    await freshRpc.closeSession({ sessionId: created.id });

    expect(await countPlanModeEnters()).toBe(0);
  });

  async function countPlanModeEnters(): Promise<number> {
    const suffix = join('agents', 'main', 'wire.jsonl');
    const entries = await readdir(homeDir, { recursive: true });
    const match = entries.find((entry) => entry.replaceAll('\\', '/').endsWith(suffix));
    if (match === undefined) {
      throw new Error('wire.jsonl not found under session home');
    }
    const lines = (await readFile(join(homeDir, match), 'utf-8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    return lines.filter((line) => (JSON.parse(line) as { type?: string }).type === 'plan_mode.enter')
      .length;
  }

  async function createTestRpc() {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    void new KimiCore(coreRpc, { homeDir, configPath });
    return sdkRpc({
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async () => ({ decision: 'rejected' as const })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
  }
});
