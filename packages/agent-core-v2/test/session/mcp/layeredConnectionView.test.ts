import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpConnectionManager, type McpServerEntry } from '#/mcpCore/connection-manager';
import { LayeredMcpConnectionView, type McpViewLayer } from '#/session/mcp/layeredConnectionView';

function disabledStdio(command: string): McpServerConfig {
  return { transport: 'stdio', command, enabled: false };
}

function layer(manager: McpConnectionManager, names: Iterable<string>): McpViewLayer & { names: Set<string> } {
  const owned = new Set(names);
  return { manager, names: owned, owns: (name) => owned.has(name) };
}

describe('LayeredMcpConnectionView', () => {
  let base: McpConnectionManager;
  let overlay: McpConnectionManager;
  let anchor: McpConnectionManager;

  beforeEach(() => {
    base = new McpConnectionManager();
    overlay = new McpConnectionManager();
    anchor = new McpConnectionManager();
  });

  afterEach(async () => {
    await Promise.all([base.shutdown(), overlay.shutdown(), anchor.shutdown()]);
  });

  it('shadows same-named base entries with overlay entries and filters their statuses', async () => {
    await base.connect('shared', disabledStdio('base-cmd'));
    await base.connect('base-only', disabledStdio('base-cmd'));
    await overlay.connect('shared', {
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
    });
    await overlay.connect('eph', disabledStdio('eph-cmd'));
    const view = new LayeredMcpConnectionView(
      () => [layer(overlay, ['shared', 'eph'])],
      layer(base, ['shared', 'base-only']),
    );

    expect(
      view
        .list()
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['base-only', 'eph', 'shared']);
    expect(view.get('shared')?.transport).toBe('http');
    expect(view.get('base-only')?.transport).toBe('stdio');

    const seen: string[] = [];
    const unsubscribe = view.onStatusChange((entry) => seen.push(entry.name));
    await base.connect('shared', disabledStdio('base-cmd'));
    await base.connect('base-only', disabledStdio('base-cmd'));
    await overlay.connect('shared', {
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
    });
    unsubscribe();

    expect(seen).toEqual(['base-only', 'shared']);
  });

  it('routes reconnect to the name owner and aggregates initial-load readiness', async () => {
    await base.connect('shared', disabledStdio('base-cmd'));
    await overlay.connect('shared', { transport: 'http', url: 'http://127.0.0.1:1/mcp' });
    expect(overlay.get('shared')?.status).toBe('failed');
    const view = new LayeredMcpConnectionView(() => [layer(overlay, ['shared'])], layer(base, ['shared']));

    await expect(view.reconnect('shared')).resolves.toBeUndefined();
    await expect(view.reconnect('unknown')).rejects.toThrow('Unknown MCP server: unknown');

    await view.waitForInitialLoad();
    expect(view.initialLoadDurationMs()).toBe(0);
  });

  it('gives each name to the first layer that defines it in precedence order', async () => {
    const sse: McpServerConfig = { transport: 'sse', url: 'https://example.com/sse', enabled: false };
    const http: McpServerConfig = { transport: 'http', url: 'https://example.com/mcp', enabled: false };
    await base.connect('everywhere', disabledStdio('user'));
    await base.connect('user-and-anchor', disabledStdio('user'));
    await base.connect('user-only', disabledStdio('user'));
    await anchor.connect('everywhere', sse);
    await anchor.connect('user-and-anchor', sse);
    await overlay.connect('everywhere', http);
    const view = new LayeredMcpConnectionView(
      () => [layer(overlay, ['everywhere']), layer(anchor, ['everywhere', 'user-and-anchor'])],
      layer(base, ['everywhere', 'user-and-anchor', 'user-only']),
    );

    expect(view.list().map((entry) => [entry.name, entry.transport])).toEqual([
      ['user-only', 'stdio'],
      ['user-and-anchor', 'sse'],
      ['everywhere', 'http'],
    ]);
    expect(view.get('everywhere')?.transport).toBe('http');
    expect(view.get('user-and-anchor')?.transport).toBe('sse');
    expect(view.get('user-only')?.transport).toBe('stdio');
  });

  it('follows live ownership and forwards statuses only from the current owner', async () => {
    const anchorLayer = layer(anchor, []);
    const view = new LayeredMcpConnectionView(() => [anchorLayer], layer(base, ['tool']));
    await base.connect('tool', disabledStdio('user'));
    const seen: Array<[string, string, string]> = [];
    const unsubscribe = view.onStatusChange((entry) => seen.push([entry.name, entry.status, entry.transport]));

    anchorLayer.names.add('tool');
    await anchor.connect('tool', { transport: 'http', url: 'https://example.com/mcp', enabled: false });
    await base.markRemoved('tool');
    expect(view.list().map((entry) => [entry.name, entry.transport])).toEqual([['tool', 'http']]);

    anchorLayer.names.delete('tool');
    await anchor.markRemoved('tool');
    await base.connect('tool', disabledStdio('user'));
    unsubscribe();

    expect(seen).toEqual([
      ['tool', 'disabled', 'http'],
      ['tool', 'disabled', 'stdio'],
    ]);
    expect(view.list().map((entry) => [entry.name, entry.transport])).toEqual([['tool', 'stdio']]);
  });

  it('replays the lower owner entry when an upper layer stops defining a name the lower layer serves', async () => {
    const anchorLayer = layer(anchor, ['tool']);
    const view = new LayeredMcpConnectionView(() => [anchorLayer], layer(base, ['tool']));
    await base.connect('tool', disabledStdio('user'));
    await anchor.connect('tool', { transport: 'http', url: 'https://example.com/mcp', enabled: false });
    const seen: Array<[string, string, string]> = [];
    const unsubscribe = view.onStatusChange((entry) => seen.push([entry.name, entry.status, entry.transport]));

    anchorLayer.names.delete('tool');
    await anchor.markRemoved('tool');
    unsubscribe();

    expect(seen).toEqual([['tool', 'disabled', 'stdio']]);
    expect(view.get('tool')).toMatchObject({ transport: 'stdio', status: 'disabled' });
  });

  it('replays the entry a subscriber has not seen when ownership moved before the layer stack changes', async () => {
    const next = new McpConnectionManager();
    try {
      await base.connect('tool', disabledStdio('user'));
      await anchor.connect('tool', { transport: 'http', url: 'https://example.com/mcp', enabled: false });
      const relayered = new Emitter<void>();
      const anchorLayer = layer(anchor, ['tool']);
      let current = anchorLayer;
      const view = new LayeredMcpConnectionView(() => [current], layer(base, ['tool']), relayered.event);
      const seen: Array<[string, string, string]> = [];
      const unsubscribe = view.onStatusChange((entry) => seen.push([entry.name, entry.status, entry.transport]));

      anchorLayer.names.delete('tool');
      current = layer(next, []);
      relayered.fire();
      unsubscribe();
      relayered.dispose();

      expect(seen).toEqual([['tool', 'disabled', 'stdio']]);
    } finally {
      await next.shutdown();
    }
  });

  it('forwards a removal from a layer that stopped defining a name no other layer defines', async () => {
    const anchorLayer = layer(anchor, ['solo']);
    const view = new LayeredMcpConnectionView(() => [anchorLayer], layer(base, []));
    await anchor.connect('solo', disabledStdio('anchor'));
    const seen: Array<[string, string]> = [];
    const unsubscribe = view.onStatusChange((entry) => seen.push([entry.name, entry.status]));

    anchorLayer.names.delete('solo');
    await anchor.markRemoved('solo');
    unsubscribe();

    expect(seen).toEqual([['solo', 'removed']]);
    expect(view.get('solo')?.status).toBe('removed');
  });

  it('serves a lower layer entry over a removed upper entry for a name no layer defines', async () => {
    const anchorLayer = layer(anchor, ['solo']);
    const view = new LayeredMcpConnectionView(() => [anchorLayer], layer(base, []));
    await anchor.connect('solo', disabledStdio('anchor'));
    anchorLayer.names.delete('solo');
    await anchor.markRemoved('solo');
    const seen: Array<[string, string, string]> = [];
    const unsubscribe = view.onStatusChange((entry) => seen.push([entry.name, entry.status, entry.transport]));

    await base.connect('solo', { transport: 'http', url: 'https://example.com/mcp', enabled: false });
    expect(view.get('solo')).toMatchObject({ transport: 'http', status: 'disabled' });
    expect(view.list().map((entry) => [entry.name, entry.transport])).toEqual([['solo', 'http']]);

    await base.markRemoved('solo');
    unsubscribe();

    expect(seen).toEqual([
      ['solo', 'disabled', 'http'],
      ['solo', 'removed', 'http'],
    ]);
    expect(view.get('solo')?.status).toBe('removed');
  });

  it('replays the visible entries that change owner when the layer stack changes', async () => {
    const next = new McpConnectionManager();
    try {
      await anchor.connect('old-only', disabledStdio('old'));
      await anchor.connect('both', disabledStdio('old'));
      await next.connect('both', disabledStdio('next'));
      await next.connect('next-only', disabledStdio('next'));
      await base.connect('user', disabledStdio('user'));
      const relayered = new Emitter<void>();
      let current = layer(anchor, ['old-only', 'both']);
      const view = new LayeredMcpConnectionView(() => [current], layer(base, ['user']), relayered.event);
      const seen: McpServerEntry[] = [];
      const unsubscribe = view.onStatusChange((entry) => seen.push(entry));

      current = layer(next, ['both', 'next-only']);
      relayered.fire();
      await anchor.connect('both', disabledStdio('old-again'));
      await next.connect('next-only', { transport: 'http', url: 'https://example.com/mcp', enabled: false });
      unsubscribe();
      relayered.dispose();

      expect(seen.map((entry) => [entry.name, entry.status, entry.transport])).toEqual([
        ['old-only', 'removed', 'stdio'],
        ['both', 'disabled', 'stdio'],
        ['next-only', 'disabled', 'stdio'],
        ['next-only', 'disabled', 'http'],
      ]);
      expect(view.list().map((entry) => entry.name).toSorted()).toEqual(['both', 'next-only', 'user']);
    } finally {
      await next.shutdown();
    }
  });
});
