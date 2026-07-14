/**
 * Core configuration RPC scenarios: strict reads preserve the last good state,
 * mutations serialize, and model-catalog snapshots commit atomically with
 * optimistic conflict protection.
 * Wiring: real KimiCore and filesystem persistence with only the RPC peer stubbed.
 * Run: pnpm --filter @moonshot-ai/agent-core exec vitest run test/rpc/config-rpc.test.ts
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';
import type { KimiModelCatalogSnapshot } from '../../src/rpc/core-api';
import type { KimiConfig } from '../../src/config';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHome(configToml?: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
  tempDirs.push(home);
  if (configToml !== undefined) {
    await writeFile(path.join(home, 'config.toml'), configToml, 'utf-8');
  }
  return home;
}

function makeCore(home: string): KimiCore {
  return new KimiCore(async () => ({}) as never, { homeDir: home });
}

function catalogSnapshot(config: KimiConfig): KimiModelCatalogSnapshot {
  return {
    providers: config.providers,
    models: config.models,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  };
}

const VALID_TOML = `
default_model = "k2"

[providers.kimi]
type = "kimi"
api_key = "sk-good"

[models.k2]
provider = "kimi"
model = "kimi-for-coding"
max_context_size = 128000
`;

describe('KimiCore degraded config loading', () => {
  it('reports no diagnostics for a valid config', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const config = await core.getKimiConfig({});
    expect(config.providers['kimi']).toBeDefined();
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });

  it('refuses to start when the TOML cannot be parsed at all', async () => {
    const home = await makeHome('[[[');
    // A fully unusable file means defaults-only (looks logged out), which is
    // worse than failing fast with the parse location.
    expect(() => makeCore(home)).toThrow(/Invalid TOML/);
  });

  it('starts with a partially invalid config, keeping the valid sections', async () => {
    const core = makeCore(
      await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`),
    );
    const config = await core.getKimiConfig({});
    expect(config.providers['kimi']).toBeDefined();
    expect(config.loopControl).toBeUndefined();
    const diagnostics = await core.getConfigDiagnostics({});
    expect(diagnostics.warnings).toHaveLength(1);
    expect(diagnostics.warnings[0]).toContain('loop_control');
  });

  it('rejects config writes with an actionable error while the file is invalid', async () => {
    const home = await makeHome(`${VALID_TOML}
[loop_control]
max_steps_per_turn = "nope"
`);
    const core = makeCore(home);
    const before = await readFile(path.join(home, 'config.toml'), 'utf-8');

    // Write paths stay strict: changing settings on top of a broken file
    // must fail with a short, actionable message — not raw validation JSON —
    // and must leave the file untouched.
    const write = core.setKimiConfig({ thinking: { enabled: true } });
    await expect(write).rejects.toThrow(/fix it first/i);
    await expect(write).rejects.toThrow(/kimi doctor/);
    await expect(write).rejects.not.toThrow(/invalid_type/);

    const after = await readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(after).toBe(before);
  });

  it('keeps the last good config when the file breaks mid-run', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);
    const configPath = path.join(home, 'config.toml');

    await writeFile(configPath, '[[[', 'utf-8');
    const kept = await core.getKimiConfig({ reload: true });
    expect(kept.providers['kimi']).toBeDefined();
    const degraded = await core.getConfigDiagnostics({});
    expect(degraded.warnings.some((w) => w.includes('Invalid TOML'))).toBe(true);
    expect(degraded.warnings.some((w) => w.includes('previous'))).toBe(true);

    await writeFile(configPath, `[thinking]\nenabled = true\n${VALID_TOML}`, 'utf-8');
    const adopted = await core.getKimiConfig({ reload: true });
    expect(adopted.thinking?.enabled).toBe(true);
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });
});

describe('KimiCore imageLimits scoping', () => {
  it('two cores keep independent [image] limits and only follow their own reloads', async () => {
    const homeA = await makeHome(`${VALID_TOML}
[image]
max_edge_px = 800
read_byte_budget = 65536
`);
    const homeB = await makeHome(`${VALID_TOML}
[image]
max_edge_px = 1600
`);
    const coreA = makeCore(homeA);
    const coreB = makeCore(homeB);

    // Baseline: each core resolves its own [image] section.
    expect(coreA.imageLimits.maxEdgePx()).toBe(800);
    expect(coreA.imageLimits.readByteBudget()).toBe(65536);
    expect(coreB.imageLimits.maxEdgePx()).toBe(1600);
    expect(coreB.imageLimits.readByteBudget()).toBe(256 * 1024);

    // Reloading B must not restamp A (the module-global regression).
    await writeFile(
      path.join(homeB, 'config.toml'),
      `${VALID_TOML}
[image]
max_edge_px = 1000
read_byte_budget = 32768
`,
      'utf-8',
    );
    await coreB.getKimiConfig({ reload: true });
    expect(coreB.imageLimits.maxEdgePx()).toBe(1000);
    expect(coreB.imageLimits.readByteBudget()).toBe(32768);
    expect(coreA.imageLimits.maxEdgePx()).toBe(800);
    expect(coreA.imageLimits.readByteBudget()).toBe(65536);
  });

  it('reloading [image] takes effect on the core instance immediately', async () => {
    const home = await makeHome(VALID_TOML);
    const core = makeCore(home);
    expect(core.imageLimits.maxEdgePx()).toBe(2000);

    await writeFile(
      path.join(home, 'config.toml'),
      `${VALID_TOML}
[image]
max_edge_px = 1400
read_byte_budget = 131072
`,
      'utf-8',
    );
    await core.getKimiConfig({ reload: true });
    expect(core.imageLimits.maxEdgePx()).toBe(1400);
    expect(core.imageLimits.readByteBudget()).toBe(131072);

    // Removing the section clears back to built-ins.
    await writeFile(path.join(home, 'config.toml'), VALID_TOML, 'utf-8');
    await core.getKimiConfig({ reload: true });
    expect(core.imageLimits.maxEdgePx()).toBe(2000);
    expect(core.imageLimits.readByteBudget()).toBe(256 * 1024);
  });
});

describe('KimiCore configuration mutations', () => {
  it('preserves both changes when independent config mutations are submitted concurrently', async () => {
    const core = makeCore(await makeHome(VALID_TOML));

    await Promise.all([
      core.setKimiConfig({ defaultPlanMode: true }),
      core.setKimiConfig({ thinking: { enabled: true } }),
    ]);

    await expect(core.getKimiConfig({ reload: true })).resolves.toMatchObject({
      defaultPlanMode: true,
      thinking: { enabled: true },
    });
  });

  it('keeps the writer usable after rejecting an asynchronous config updater', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const asynchronousUpdate = (async (config: KimiConfig) => {
      config.defaultPlanMode = true;
    }) as unknown as (config: KimiConfig) => never;

    await expect(core.mutateKimiConfig(asynchronousUpdate)).rejects.toThrow(/synchronous/i);
    await core.setKimiConfig({ thinking: { enabled: true } });

    await expect(core.getKimiConfig({ reload: true })).resolves.toMatchObject({
      thinking: { enabled: true },
    });
    expect((await core.getKimiConfig({})).defaultPlanMode).not.toBe(true);
  });

  it('replaces the complete model catalog while preserving unrelated config', async () => {
    const core = makeCore(
      await makeHome(`default_provider = "kimi"
${VALID_TOML}

[thinking]
enabled = true

[image]
max_edge_px = 1400
`),
    );
    const expected = catalogSnapshot(await core.getKimiConfig({}));

    const updated = await core.replaceKimiModelCatalog({
      expected,
      next: {
        providers: {
          replacement: {
            type: 'openai',
            apiKey: 'YOUR_API_KEY',
          },
        },
        models: {
          replacement: {
            provider: 'replacement',
            model: 'replacement-model',
            maxContextSize: 262144,
          },
        },
        defaultProvider: undefined,
        defaultModel: undefined,
        thinking: undefined,
      },
    });

    expect(catalogSnapshot(updated)).toEqual({
      providers: {
        replacement: {
          type: 'openai',
          apiKey: 'YOUR_API_KEY',
        },
      },
      models: {
        replacement: {
          provider: 'replacement',
          model: 'replacement-model',
          maxContextSize: 262144,
        },
      },
      defaultProvider: undefined,
      defaultModel: undefined,
      thinking: undefined,
    });
    expect(updated.image).toEqual({ maxEdgePx: 1400 });
  });

  it('rejects a stale catalog replacement without overwriting the newer config', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const expected = catalogSnapshot(await core.getKimiConfig({}));
    await core.setKimiConfig({
      models: {
        userAdded: {
          provider: 'kimi',
          model: 'user-added',
          maxContextSize: 64000,
        },
      },
    });

    await expect(
      core.replaceKimiModelCatalog({
        expected,
        next: {
          providers: {},
          models: {},
          defaultProvider: undefined,
          defaultModel: undefined,
          thinking: undefined,
        },
      }),
    ).rejects.toThrow(/changed while provider models were refreshing/i);

    const kept = await core.getKimiConfig({ reload: true });
    expect(kept.models?.['userAdded']).toMatchObject({ model: 'user-added' });
    expect(kept.providers['kimi']).toBeDefined();
  });
});
