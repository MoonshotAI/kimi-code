import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationService } from '#/_base/di/instantiationService';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import {
  AgentProfileContribution,
  type AgentProfileContributionRecord,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

interface IContributor {
  readonly record: AgentProfileContributionRecord;
}
const IContributor = createDecorator<IContributor>('test-agent-profile-contributor');

class Contributor extends Service implements IContributor {
  declare readonly _serviceBrand: undefined;

  constructor(readonly record: AgentProfileContributionRecord) {
    super();
    this.provide(AgentProfileContribution, record);
  }
}

function record(
  sourceId: string,
  marker: string,
  options?: { readonly priority?: number; readonly workspaceKey?: string },
): AgentProfileContributionRecord {
  return {
    sourceId,
    priority: options?.priority,
    workspaceKey: options?.workspaceKey,
    contribution: { profiles: [normalizeAgentProfile({ name: marker, systemPrompt: () => marker })] },
  };
}

function makeFold(): {
  readonly container: InstantiationService;
  readonly registry: AgentProfileRegistryService;
} {
  const container = new InstantiationService(new ServiceCollection(), true);
  const registry = container.createInstance(AgentProfileRegistryService);
  return { container, registry };
}

function contribute(
  container: InstantiationService,
  value: AgentProfileContributionRecord,
): IDisposable {
  const child = container.createChild(new ServiceCollection()) as InstantiationService;
  child.provide(IContributor, new SyncDescriptor(Contributor, [value] as never));
  child.invokeFunction((accessor) => accessor.get(IContributor));
  return child;
}

describe('AgentProfileRegistryService (collection fold)', () => {
  it('lets a later record for the same pair shadow the earlier one', () => {
    const { container, registry } = makeFold();
    contribute(container, record('user', 'v1'));
    contribute(container, record('user', 'v2'));

    const entries = registry.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.contribution.profiles[0]?.name).toBe('v2');
    container.dispose();
  });

  it('keeps same-sourceId records with different workspaceKeys coexisting', () => {
    const { container, registry } = makeFold();
    contribute(container, record('workspace', 'global'));
    const wdA = contribute(container, record('workspace', 'wd_a', { workspaceKey: 'wd_a' }));
    contribute(container, record('workspace', 'wd_b', { workspaceKey: 'wd_b' }));
    wdA.dispose();
    contribute(container, record('workspace', 'wd_a-v2', { workspaceKey: 'wd_a' }));

    const entries = registry.entries();
    expect(entries).toHaveLength(3);
    const byKey = new Map(entries.map((entry) => [entry.workspaceKey, entry]));
    expect(byKey.get(undefined)?.contribution.profiles[0]?.name).toBe('global');
    expect(byKey.get('wd_a')?.contribution.profiles[0]?.name).toBe('wd_a-v2');
    expect(byKey.get('wd_b')?.contribution.profiles[0]?.name).toBe('wd_b');
    container.dispose();
  });

  it('withdraws only the dead provider’s record', () => {
    const { container, registry } = makeFold();
    const wdA = contribute(container, record('workspace', 'wd_a', { workspaceKey: 'wd_a' }));
    const wdB = contribute(container, record('workspace', 'wd_b', { workspaceKey: 'wd_b' }));
    const global = contribute(container, record('user', 'global'));

    wdA.dispose();
    expect(registry.entries().map((entry) => entry.workspaceKey)).toEqual(['wd_b', undefined]);

    wdB.dispose();
    expect(registry.entries().map((entry) => entry.sourceId)).toEqual(['user']);

    global.dispose();
    expect(registry.entries()).toHaveLength(0);
    container.dispose();
  });

  it('withdrawing a shadowed record keeps the winning entry and stays silent', () => {
    const { container, registry } = makeFold();
    const stale = contribute(container, record('workspace', 'old', { workspaceKey: 'wd_a' }));
    contribute(container, record('workspace', 'new', { workspaceKey: 'wd_a' }));

    const seen: unknown[] = [];
    const subscription = registry.onDidChange((change) => seen.push(change));
    stale.dispose();

    const entries = registry.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.contribution.profiles[0]?.name).toBe('new');
    expect(seen).toEqual([]);
    subscription.dispose();
    container.dispose();
  });

  it('exposes sourceId, priority, workspaceKey, and contribution through entries()', () => {
    const { container, registry } = makeFold();
    const pluginRecord = record('plugin', 'plugin-p', { priority: 5 });
    const workspaceRecord = record('workspace', 'ws-p', { priority: 30, workspaceKey: 'wd_a' });
    contribute(container, pluginRecord);
    contribute(container, workspaceRecord);

    const entries = registry.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      sourceId: 'plugin',
      priority: 5,
      workspaceKey: undefined,
      contribution: pluginRecord.contribution,
    });
    expect(entries[1]).toEqual({
      sourceId: 'workspace',
      priority: 30,
      workspaceKey: 'wd_a',
      contribution: workspaceRecord.contribution,
    });
    contribute(container, record('user', 'user-p'));
    expect(registry.entries()[2]?.priority).toBe(0);
    container.dispose();
  });

  it('fires onDidChange with the decoded { sourceId, workspaceKey } payload', () => {
    const { container, registry } = makeFold();
    const seen: { readonly sourceId: string; readonly workspaceKey?: string }[] = [];
    const subscription = registry.onDidChange((change) => seen.push(change));

    contribute(container, record('user', 'global'));
    const wdA = contribute(container, record('workspace', 'wd_a', { workspaceKey: 'wd_a' }));
    wdA.dispose();

    expect(seen).toStrictEqual([
      { sourceId: 'user', workspaceKey: undefined },
      { sourceId: 'workspace', workspaceKey: 'wd_a' },
      { sourceId: 'workspace', workspaceKey: 'wd_a' },
    ]);
    subscription.dispose();
    container.dispose();
  });

  it('fires once when a record swap lands before the displaced one is withdrawn (the reload shape)', () => {
    const { container, registry } = makeFold();
    const stale = contribute(container, record('user', 'v1'));

    const seen: { readonly sourceId: string; readonly workspaceKey?: string }[] = [];
    const subscription = registry.onDidChange((change) => seen.push(change));
    contribute(container, record('user', 'v2'));
    stale.dispose();

    expect(registry.entries()[0]?.contribution.profiles[0]?.name).toBe('v2');
    expect(seen).toStrictEqual([{ sourceId: 'user', workspaceKey: undefined }]);
    subscription.dispose();
    container.dispose();
  });
});
