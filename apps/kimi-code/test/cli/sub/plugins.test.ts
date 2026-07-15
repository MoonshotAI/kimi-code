import { describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import {
  handlePluginsEnable,
  handlePluginsInfo,
  handlePluginsInstall,
  handlePluginsList,
  handlePluginsMarketplace,
  handlePluginsRegistryAdd,
  handlePluginsRegistryList,
  handlePluginsRegistryRemove,
  handlePluginsRemove,
  registerPluginsCommand,
} from '#/cli/sub/plugins';
import type { PluginInfo, PluginSummary } from '@moonshot-ai/kimi-code-sdk';
import type { PluginMarketplace } from '#/utils/plugin-marketplace';

const mocks = vi.hoisted(() => ({
  shutdownTelemetry: vi.fn(),
  createCliTelemetryBootstrap: vi.fn(() => ({
    homeDir: '/tmp/kimi-home',
    deviceId: 'device-id',
    firstLaunch: false,
  })),
  initializeCliTelemetry: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  track: vi.fn(),
  setTelemetryContext: vi.fn(),
  withTelemetryContext: vi.fn(),
  shutdownTelemetry: mocks.shutdownTelemetry,
}));

vi.mock('../../../src/cli/telemetry', () => ({
  createCliTelemetryBootstrap: mocks.createCliTelemetryBootstrap,
  initializeCliTelemetry: mocks.initializeCliTelemetry,
}));

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    cwd: () => '/tmp/work',
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never,
    getHarness: vi.fn(),
    getHomeDir: () => '/home/example/.kimi-code',
    ...overrides,
  };
}

function getWritten(stream: { write: ReturnType<typeof vi.fn> }): string {
  return stream.write.mock.calls.map((c: unknown[]) => c[0]).join('');
}

function makePluginSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'demo',
    displayName: 'Demo',
    version: '1.0.0',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    ...overrides,
  };
}

function makePluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    ...makePluginSummary(),
    root: '/plugins/demo',
    installedAt: new Date().toISOString(),
    mcpServers: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeMarketplace(overrides: Partial<PluginMarketplace> = {}): PluginMarketplace {
  return {
    source: 'https://example.com/marketplace.json',
    plugins: [
      {
        id: 'market-demo',
        displayName: 'Market Demo',
        version: '2.0.0',
        description: 'A demo plugin',
        source: 'https://example.com/market-demo.zip',
      },
    ],
    ...overrides,
  };
}

describe('handlePluginsList', () => {
  it('prints installed plugins as JSON', async () => {
    const summary = makePluginSummary();
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        listPlugins: vi.fn(async () => [summary]),
      })),
    });

    await handlePluginsList(deps as never, { json: true });

    expect(getWritten(deps.stdout)).toContain('"id": "demo"');
  });
});

describe('handlePluginsInfo', () => {
  it('prints plugin info as JSON', async () => {
    const info = makePluginInfo();
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        getPluginInfo: vi.fn(async () => info),
      })),
    });

    await handlePluginsInfo(deps as never, 'demo', { json: true });

    expect(getWritten(deps.stdout)).toContain('"id": "demo"');
  });

  it('prints plugin info as text', async () => {
    const info = makePluginInfo({ id: 'demo', displayName: 'Demo' });
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        getPluginInfo: vi.fn(async () => info),
      })),
    });

    await handlePluginsInfo(deps as never, 'demo', {});

    expect(getWritten(deps.stdout)).toContain('ID:');
    expect(getWritten(deps.stdout)).toContain('demo');
  });
});

describe('handlePluginsInstall', () => {
  it('installs a plugin without confirmation when --yes is passed', async () => {
    const summary = makePluginSummary();
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        listPlugins: vi.fn(async () => []),
        installPlugin: vi.fn(async () => summary),
      })),
    });

    await handlePluginsInstall(deps as never, { source: '/tmp/demo', yes: true });

    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining('demo'));
  });

  it('cancels third-party install when not confirmed', async () => {
    const installPlugin = vi.fn(async () => makePluginSummary());
    const deps = makeDeps({
      confirm: vi.fn(async () => false),
      getHarness: vi.fn(() => ({
        installPlugin,
      })),
    });

    await handlePluginsInstall(deps as never, { source: '/tmp/demo' });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(getWritten(deps.stdout)).toContain('Install cancelled.');
  });
});

describe('handlePluginsRemove', () => {
  it('removes a plugin after confirmation', async () => {
    const removePlugin = vi.fn(async () => undefined);
    const deps = makeDeps({
      confirm: vi.fn(async () => true),
      getHarness: vi.fn(() => ({
        getPluginInfo: vi.fn(async () => makePluginInfo({ id: 'demo', displayName: 'Demo' })),
        removePlugin,
      })),
    });

    await handlePluginsRemove(deps as never, { id: 'demo' });

    expect(removePlugin).toHaveBeenCalledWith('demo');
    expect(getWritten(deps.stdout)).toContain('Removed demo.');
  });

  it('cancels remove when not confirmed', async () => {
    const removePlugin = vi.fn(async () => undefined);
    const deps = makeDeps({
      confirm: vi.fn(async () => false),
      getHarness: vi.fn(() => ({
        getPluginInfo: vi.fn(async () => makePluginInfo({ id: 'demo', displayName: 'Demo' })),
        removePlugin,
      })),
    });

    await handlePluginsRemove(deps as never, { id: 'demo' });

    expect(removePlugin).not.toHaveBeenCalled();
    expect(getWritten(deps.stdout)).toContain('Remove cancelled.');
  });
});

describe('handlePluginsEnable', () => {
  it('enables a plugin', async () => {
    const setPluginEnabled = vi.fn(async () => undefined);
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        setPluginEnabled,
      })),
    });

    await handlePluginsEnable(deps as never, { id: 'demo', enabled: true });

    expect(setPluginEnabled).toHaveBeenCalledWith('demo', true);
    expect(getWritten(deps.stdout)).toContain('Enabled demo.');
  });

  it('disables a plugin', async () => {
    const setPluginEnabled = vi.fn(async () => undefined);
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        setPluginEnabled,
      })),
    });

    await handlePluginsEnable(deps as never, { id: 'demo', enabled: false });

    expect(setPluginEnabled).toHaveBeenCalledWith('demo', false);
    expect(getWritten(deps.stdout)).toContain('Disabled demo.');
  });
});

describe('handlePluginsMarketplace', () => {
  it('prints merged marketplace plugins as JSON', async () => {
    const loadMergedMarketplace = vi.fn(async () => makeMarketplace());
    const deps = makeDeps({ loadMergedMarketplace });

    await handlePluginsMarketplace(deps as never, { json: true });

    expect(loadMergedMarketplace).toHaveBeenCalledWith({
      kimiHomeDir: '/home/example/.kimi-code',
      workDir: '/tmp/work',
    });
    expect(getWritten(deps.stdout)).toContain('"id": "market-demo"');
  });

  it('prints marketplace from a specific registry', async () => {
    const resolveRegistryUrl = vi.fn(async () => 'https://custom.example.com/m.json');
    const loadPluginMarketplace = vi.fn(async () => makeMarketplace());
    const deps = makeDeps({ resolveRegistryUrl, loadPluginMarketplace });

    await handlePluginsMarketplace(deps as never, { registry: 'custom', json: true });

    expect(resolveRegistryUrl).toHaveBeenCalledWith('/home/example/.kimi-code', 'custom');
    expect(loadPluginMarketplace).toHaveBeenCalledWith({
      workDir: '/tmp/work',
      source: 'https://custom.example.com/m.json',
    });
    expect(getWritten(deps.stdout)).toContain('"id": "market-demo"');
  });
});

describe('handlePluginsRegistryList', () => {
  it('lists registries as JSON', async () => {
    const readRegistries = vi.fn(async () => ({
      registries: [{ name: 'custom', url: 'https://custom.example.com/m.json' }],
    }));
    const deps = makeDeps({ readRegistries });

    await handlePluginsRegistryList(deps as never, { json: true });

    expect(readRegistries).toHaveBeenCalledWith('/home/example/.kimi-code');
    expect(getWritten(deps.stdout)).toContain('https://custom.example.com/m.json');
  });

  it('reports no custom registries', async () => {
    const readRegistries = vi.fn(async () => ({ registries: [] }));
    const deps = makeDeps({ readRegistries });

    await handlePluginsRegistryList(deps as never, {});

    expect(getWritten(deps.stdout)).toContain('No custom registries.');
  });
});

describe('handlePluginsRegistryAdd', () => {
  it('adds a registry', async () => {
    const addRegistry = vi.fn(async () => undefined);
    const deps = makeDeps({ addRegistry });

    await handlePluginsRegistryAdd(deps as never, { url: 'https://example.com/m.json', name: 'example' });

    expect(addRegistry).toHaveBeenCalledWith('/home/example/.kimi-code', {
      url: 'https://example.com/m.json',
      name: 'example',
    });
  });
});

describe('handlePluginsRegistryRemove', () => {
  it('removes a registry', async () => {
    const removeRegistry = vi.fn(async () => undefined);
    const deps = makeDeps({ removeRegistry });

    await handlePluginsRegistryRemove(deps as never, { nameOrUrl: 'custom' });

    expect(removeRegistry).toHaveBeenCalledWith('/home/example/.kimi-code', 'custom');
    expect(getWritten(deps.stdout)).toContain('Removed registry custom.');
  });
});

describe('handler errors', () => {
  it('throws when getting plugin info fails', async () => {
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        getPluginInfo: vi.fn(async () => {
          throw new Error('boom');
        }),
      })),
    });

    await expect(handlePluginsInfo(deps as never, 'demo', { json: true })).rejects.toThrow(
      'Failed to get plugin info: boom',
    );
    expect(deps.exit).not.toHaveBeenCalled();
  });
});

describe('registerPluginsCommand', () => {
  function makeHarness(overrides: Record<string, unknown> = {}) {
    return {
      listPlugins: vi.fn(async () => []),
      ensureConfigFile: vi.fn(async () => undefined),
      getConfig: vi.fn(async () => ({ telemetry: false, defaultModel: 'kimi' })),
      close: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('cleans up and exits 1 when a handler throws', async () => {
    const harness = makeHarness({
      listPlugins: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never;
    const stderr = { write: vi.fn() };
    const parent = new Command();
    registerPluginsCommand(parent, {
      getHarness: () => harness as never,
      stderr,
      exit,
      cwd: () => '/tmp/work',
      getHomeDir: () => '/tmp/kimi-home',
    });

    await expect(parent.parseAsync(['node', 'test', 'plugins', 'list'])).rejects.toThrow('exit:1');

    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
    expect(getWritten(stderr)).toContain('Failed to list plugins: boom');
  });

  it('cleans up and returns normally on success', async () => {
    const harness = makeHarness();
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never;
    const parent = new Command();
    registerPluginsCommand(parent, {
      getHarness: () => harness as never,
      exit,
      cwd: () => '/tmp/work',
      getHomeDir: () => '/tmp/kimi-home',
    });

    await expect(parent.parseAsync(['node', 'test', 'plugins', 'list'])).resolves.not.toThrow();

    expect(exit).not.toHaveBeenCalled();
    expect(mocks.shutdownTelemetry).toHaveBeenCalled();
  });
});
