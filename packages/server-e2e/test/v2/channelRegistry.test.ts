/**
 * Drift guard for the server-v2 channel registry.
 *
 * In the VS Code model a registered Service exposes all of its methods by
 * reflection, so the channel registry (keyed by decorator id) *is* the `/api/v2`
 * surface. This test fails if a core channel is accidentally removed or renamed
 * (the decorator id is the public channel name).
 *
 * Note: the legacy SDK resource manifest (public `resource`/`action` names) is
 * no longer cross-checked here — it is being migrated to the decorator-id model
 * separately. Until then this guard pins the server side of the contract.
 */
import { describeChannels, registeredChannelNames } from '@moonshot-ai/kap-server/contract';
import { describe, expect, it } from 'vitest';

describe('v2 server channel registry', () => {
  it('exposes the pinned channels across scopes', () => {
    const names = registeredChannelNames();
    // core
    expect(names).toContain('sessionIndex');
    expect(names).toContain('workspaceRegistry');
    // session
    expect(names).toContain('sessionMetadata');
    // agent (facade-backed)
    expect(names).toContain('agentRPCService');
  });

  it('describes scope and methods for every channel', () => {
    const channels = describeChannels();
    expect(channels.map((c) => c.name)).toEqual(registeredChannelNames());

    const byName = new Map(channels.map((c) => [c.name, c]));
    // Scope is derived from the scoped DI registry, not the comments in
    // `EXPOSED_SERVICES` — `sessionLifecycleService` is App-registered.
    expect(byName.get('sessionIndex')?.scope).toBe('app');
    expect(byName.get('sessionLifecycleService')?.scope).toBe('app');
    expect(byName.get('sessionMetadata')?.scope).toBe('session');
    expect(byName.get('agentRPCService')?.scope).toBe('agent');

    const meta = byName.get('sessionMetadata');
    expect(meta?.methods.map((m) => m.name)).toEqual(
      expect.arrayContaining(['read', 'setTitle', 'update']),
    );
    // Parameter names are recovered from the declaration source.
    expect(meta?.methods.find((m) => m.name === 'setTitle')?.params).toBe('title');
    expect(meta?.methods.find((m) => m.name === 'read')?.params).toBe('');
    // Events are instance properties; framework plumbing is excluded.
    const names = meta?.methods.map((m) => m.name) ?? [];
    expect(names).not.toContain('onDidChangeMetadata');
    expect(names).not.toContain('dispose');
  });
});
