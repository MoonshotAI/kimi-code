import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';

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
