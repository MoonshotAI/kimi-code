/**
 * Scenario: the App-scope agent-profile registry service.
 *
 * Exercises `AgentProfileRegistryService` directly: the (sourceId,
 * workspaceKey) storage-key encoding (one global entry per source id, with
 * same-id workspace-local entries coexisting across handlers), the scoped
 * `unregister` / dispose-handle semantics, the `entries()` metadata, and the
 * decoded `onDidChange` payload. The generic contribution registry
 * underneath is covered by `test/_base/contribution/registry.test.ts`; this
 * suite only pins the service layer's workspaceKey dimension. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/agentProfileCatalog/agentProfileRegistry.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';

function contribution(marker: string): AgentProfileContribution {
  return { profiles: [normalizeAgentProfile({ name: marker, systemPrompt: () => marker })] };
}

describe('AgentProfileRegistryService', () => {
  it('replaces a same-sourceId global registration', () => {
    const registry = new AgentProfileRegistryService();
    registry.register('user', contribution('v1'));
    registry.register('user', contribution('v2'));

    const entries = registry.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.contribution.profiles[0]?.name).toBe('v2');
    registry.dispose();
  });

  it('keeps same-sourceId entries with different workspaceKeys coexisting', () => {
    const registry = new AgentProfileRegistryService();
    registry.register('workspace', contribution('global'));
    registry.register('workspace', contribution('wd_a'), { workspaceKey: 'wd_a' });
    registry.register('workspace', contribution('wd_b'), { workspaceKey: 'wd_b' });
    // Re-registering one key replaces only that key's entry.
    registry.register('workspace', contribution('wd_a-v2'), { workspaceKey: 'wd_a' });

    const entries = registry.entries();
    expect(entries).toHaveLength(3);
    const byKey = new Map(entries.map((entry) => [entry.workspaceKey, entry]));
    expect(byKey.get(undefined)?.contribution.profiles[0]?.name).toBe('global');
    expect(byKey.get('wd_a')?.contribution.profiles[0]?.name).toBe('wd_a-v2');
    expect(byKey.get('wd_b')?.contribution.profiles[0]?.name).toBe('wd_b');
    registry.dispose();
  });

  it('unregister(sourceId, workspaceKey) removes only the matching entry', () => {
    const registry = new AgentProfileRegistryService();
    registry.register('workspace', contribution('wd_a'), { workspaceKey: 'wd_a' });
    registry.register('workspace', contribution('wd_b'), { workspaceKey: 'wd_b' });
    registry.register('user', contribution('global'));

    registry.unregister('workspace', 'wd_a');
    expect(registry.entries().map((entry) => entry.workspaceKey)).toEqual(['wd_b', undefined]);

    registry.unregister('workspace', 'wd_b');
    expect(registry.entries().map((entry) => entry.sourceId)).toEqual(['user']);

    registry.unregister('user');
    expect(registry.entries()).toHaveLength(0);
    registry.dispose();
  });

  it('a dispose handle removes only the entry it registered', () => {
    const registry = new AgentProfileRegistryService();
    const stale = registry.register('workspace', contribution('old'), { workspaceKey: 'wd_a' });
    registry.register('workspace', contribution('new'), { workspaceKey: 'wd_a' });

    stale.dispose();

    const entries = registry.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.contribution.profiles[0]?.name).toBe('new');
    registry.dispose();
  });

  it('exposes sourceId, priority, workspaceKey, and contribution through entries()', () => {
    const registry = new AgentProfileRegistryService();
    const pluginContribution = contribution('plugin-p');
    const workspaceContribution = contribution('ws-p');
    registry.register('plugin', pluginContribution, { priority: 5 });
    registry.register('workspace', workspaceContribution, {
      priority: 30,
      workspaceKey: 'wd_a',
    });

    const entries = registry.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      sourceId: 'plugin',
      priority: 5,
      workspaceKey: undefined,
      contribution: pluginContribution,
    });
    expect(entries[1]).toEqual({
      sourceId: 'workspace',
      priority: 30,
      workspaceKey: 'wd_a',
      contribution: workspaceContribution,
    });
    // Priority defaults to 0 when omitted.
    registry.register('user', contribution('user-p'));
    expect(registry.entries()[2]?.priority).toBe(0);
    registry.dispose();
  });

  it('fires onDidChange with the decoded { sourceId, workspaceKey } payload', () => {
    const registry = new AgentProfileRegistryService();
    const seen: { readonly sourceId: string; readonly workspaceKey?: string }[] = [];
    const subscription = registry.onDidChange((change) => seen.push(change));

    registry.register('user', contribution('global'));
    registry.register('workspace', contribution('wd_a'), { workspaceKey: 'wd_a' });
    registry.unregister('workspace', 'wd_a');
    // Unregistering a missing entry stays silent.
    registry.unregister('workspace', 'wd_b');

    expect(seen).toStrictEqual([
      { sourceId: 'user', workspaceKey: undefined },
      { sourceId: 'workspace', workspaceKey: 'wd_a' },
      { sourceId: 'workspace', workspaceKey: 'wd_a' },
    ]);
    subscription.dispose();
    registry.dispose();
  });
});
