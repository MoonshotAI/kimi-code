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
  it('activates plan mode when explicitly toggled via setPlanMode', async () => {
    await writeFile(configPath, BASE_CONFIG);
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });

    await rpc.setPlanMode({ sessionId: created.id, agentId: 'main', enabled: true });
    await rpc.closeSession({ sessionId: created.id });

    expect(await countPlanModeEnters()).toBe(1);
  });

  it('deactivates plan mode when explicitly toggled off after activation', async () => {
    await writeFile(configPath, `default_plan_mode = true\n${BASE_CONFIG}`);
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });

    await rpc.setPlanMode({ sessionId: created.id, agentId: 'main', enabled: false });
    await rpc.closeSession({ sessionId: created.id });

    // One enter from creation, one exit from toggle — net plan_mode.enter should be 1.
    expect(await countPlanModeEnters()).toBe(1);
  });

  it('handles setPlanMode on a session with no model configured', async () => {
    await writeFile(configPath, '');
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });

    // Should not throw even when there is no model configured.
    await expect(
      rpc.setPlanMode({ sessionId: created.id, agentId: 'main', enabled: true }),
    ).resolves.not.toThrow();
  });

  it('toggle setPlanMode multiple times does not leak plan mode enters', async () => {
    await writeFile(configPath, BASE_CONFIG);
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });

    for (let i = 0; i < 3; i++) {
      await rpc.setPlanMode({ sessionId: created.id, agentId: 'main', enabled: true });
      await rpc.setPlanMode({ sessionId: created.id, agentId: 'main', enabled: false });
    }
    await rpc.closeSession({ sessionId: created.id });

    // Each enable toggle produces exactly one enter record. With 3 cycles = 3 enters.
    expect(await countPlanModeEnters()).toBe(3);
  }, 15_000);

  it('does not fail when resuming a session with an empty wire file', async () => {
    await writeFile(configPath, BASE_CONFIG);
    const rpc = await createTestRpc();
    const created = await rpc.createSession({ workDir });
    await rpc.closeSession({ sessionId: created.id });

    // Corrupt the wire file by emptying it
    const suffix = join('agents', 'main', 'wire.jsonl');
    const entries = await readdir(homeDir, { recursive: true });
    const match = entries.find((entry) => entry.replaceAll('\\', '/').endsWith(suffix));
    if (match) {
      await writeFile(join(homeDir, match), '');
    }

    const freshRpc = await createTestRpc();
    await expect(freshRpc.resumeSession({ sessionId: created.id })).resolves.toBeDefined();
  });
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
