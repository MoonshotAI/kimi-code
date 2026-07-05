import { describe, expect, it, vi } from 'vitest';

import {
  handlePluginsInstall,
  handlePluginsList,
  handlePluginsRegistryAdd,
  handlePluginsRegistryList,
  handlePluginsRemove,
} from '#/cli/sub/plugins';
import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    cwd: () => '/tmp/work',
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never,
    getHarness: vi.fn(),
    getHomeDir: () => '/home/cyijun/.kimi-code',
    ...overrides,
  };
}

describe('handlePluginsList', () => {
  it('prints installed plugins as JSON', async () => {
    const summary: PluginSummary = {
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
    };
    const deps = makeDeps({
      getHarness: vi.fn(() => ({
        listPlugins: vi.fn(async () => [summary]),
      })),
    });

    await handlePluginsList(deps as never, { json: true });

    const written = (deps.stdout.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('"id": "demo"');
  });
});

describe('handlePluginsInstall', () => {
  it('installs a plugin without confirmation when --yes is passed', async () => {
    const summary: PluginSummary = {
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
    };
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
});

describe('handlePluginsRegistryAdd', () => {
  it('adds a registry', async () => {
    const addRegistry = vi.fn(async () => undefined);
    const deps = makeDeps({ addRegistry });

    await handlePluginsRegistryAdd(deps as never, { url: 'https://example.com/m.json', name: 'example' });

    expect(addRegistry).toHaveBeenCalledWith('/home/cyijun/.kimi-code', {
      url: 'https://example.com/m.json',
      name: 'example',
    });
  });
});
