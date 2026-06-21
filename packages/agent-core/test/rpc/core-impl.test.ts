import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginRecord, PluginSummary } from '../../src/plugin';
import { KimiCore } from '../../src/rpc/core-impl';
import { getCoreVersion } from '../../src/version';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHome(configToml?: string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'kimi-core-wire-'));
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

function makePluginRecord(id: string): PluginRecord {
  return {
    id,
    root: `/tmp/${id}`,
    source: 'local-path',
    enabled: true,
    state: 'ok',
    installedAt: '2026-06-21T00:00:00.000Z',
    skillCount: 0,
    diagnostics: [],
  };
}

function makePluginSummary(id: string): PluginSummary {
  return {
    id,
    displayName: id,
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hasErrors: false,
    source: 'local-path',
  };
}

describe('KimiCore wire controller delegates CoreAPI methods to domain services', () => {
  it('listSessions delegates to the session store', async () => {
    const core = makeCore(await makeHome());
    await expect(core.listSessions({})).resolves.toEqual([]);
  });

  it('getKimiConfig / getConfigDiagnostics delegate to the loaded config', async () => {
    const core = makeCore(await makeHome(VALID_TOML));
    const config = await core.getKimiConfig({});
    expect(config.providers['kimi']).toBeDefined();
    await expect(core.getConfigDiagnostics({})).resolves.toEqual({ warnings: [] });
  });

  it('getCoreInfo returns the core version', async () => {
    const core = makeCore(await makeHome());
    expect(core.getCoreInfo()).toEqual({ version: getCoreVersion() });
  });

  it('session-scoped methods route through the session registry before SessionAPIImpl', async () => {
    const core = makeCore(await makeHome());
    // No session registered -> the sessionApi() lookup fails before reaching
    // SessionAPIImpl, proving the registry is the wire seam for per-session calls.
    expect(() => core.getModel({ sessionId: 'missing', agentId: 'main' })).toThrow(/was not found/);
  });

  it('installPlugin delegates to the plugin service install + summaries', async () => {
    const core = makeCore(await makeHome());
    // Settle the initial plugin load so assertPluginsLoaded() passes.
    await expect(core.listPlugins({})).resolves.toEqual([]);

    const record = makePluginRecord('demo');
    const summary = makePluginSummary('demo');
    const installSpy = vi.spyOn(core.plugins, 'install').mockResolvedValue(record);
    const summariesSpy = vi.spyOn(core.plugins, 'summaries').mockReturnValue([summary]);

    const result = await core.installPlugin({ source: '/tmp/whatever' });

    expect(installSpy).toHaveBeenCalledWith('/tmp/whatever');
    expect(summariesSpy).toHaveBeenCalled();
    expect(result).toBe(summary);
  });

  it('listPlugins delegates to the plugin service summaries', async () => {
    const core = makeCore(await makeHome());
    await expect(core.listPlugins({})).resolves.toEqual([]);

    const summary = makePluginSummary('demo');
    vi.spyOn(core.plugins, 'summaries').mockReturnValue([summary]);

    await expect(core.listPlugins({})).resolves.toEqual([summary]);
  });
});
