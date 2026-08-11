/**
 * Scenario: the Session-scope agent-profile catalog projection over the
 * App-scope `IAgentProfileRegistry` fold.
 *
 * Exercises `SessionAgentProfileCatalogService` directly: the registry fold
 * is fed through real containers (contributor units on the same
 * `this.provide` path the production loaders take) while the catalog itself
 * is hand-constructed — the suite verifies the projection rules:
 * relevant-entry filtering by the seeded workspace key, priority-ordered
 * name dedup, the builtin-override rule, change-event fan-out, and the read
 * surface (`get` / `list` / `getDefault` / `inspect`). Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationService } from '#/_base/di/instantiationService';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { BUILTIN_AGENT_PROFILE_SOURCE_ID } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { SessionAgentProfileCatalogService } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  AgentProfileContribution,
  type AgentProfileContributionRecord,
} from '#/app/agentProfileCatalog/agentProfileContribution';

import { stubLog } from '../../_base/log/stubs';

const WORKSPACE_KEY = 'wd_a';

interface IContributor {
  readonly record: AgentProfileContributionRecord;
}
const IContributor = createDecorator<IContributor>('test-session-profile-contributor');

class Contributor extends Service implements IContributor {
  declare readonly _serviceBrand: undefined;

  constructor(readonly record: AgentProfileContributionRecord) {
    super();
    this.provide(AgentProfileContribution, record);
  }
}

function profile(name: string, options?: { readonly override?: boolean }): AgentProfile {
  return normalizeAgentProfile({
    name,
    override: options?.override,
    systemPrompt: () => `prompt:${name}`,
  });
}

function makeCatalog(workspaceKey: string = WORKSPACE_KEY) {
  const container = new InstantiationService(new ServiceCollection(), true);
  const registry = container.createInstance(AgentProfileRegistryService);
  const catalog = new SessionAgentProfileCatalogService(
    registry,
    { _serviceBrand: undefined, workspaceKey },
    stubLog(),
  );
  const contribute = (
    sourceId: string,
    profiles: readonly AgentProfile[],
    options?: { readonly priority?: number; readonly workspaceKey?: string },
  ): IDisposable => {
    const child = container.createChild(new ServiceCollection()) as InstantiationService;
    const contributionRecord: AgentProfileContributionRecord = {
      sourceId,
      priority: options?.priority,
      workspaceKey: options?.workspaceKey,
      contribution: { profiles },
    };
    child.provide(IContributor, new SyncDescriptor(Contributor, [contributionRecord] as never));
    child.invokeFunction((accessor) => accessor.get(IContributor));
    return child;
  };
  return { container, registry, catalog, contribute };
}

describe('SessionAgentProfileCatalogService (registry projection)', () => {
  it('projects global entries and own-workspace entries, filtering other workspace keys', () => {
    const { container, catalog, contribute } = makeCatalog();
    const globalProfile = profile('global-p');
    const ownProfile = profile('own-ws-p');
    contribute('user', [globalProfile]);
    contribute('workspace', [ownProfile], { workspaceKey: 'wd_a' });
    contribute('workspace', [profile('other-ws-p')], { workspaceKey: 'wd_b' });

    expect(catalog.get('global-p')).toBe(globalProfile);
    expect(catalog.get('own-ws-p')).toBe(ownProfile);
    expect(catalog.get('other-ws-p')).toBeUndefined();
    catalog.dispose();
    container.dispose();
  });

  it('excludes same-name profiles of other workspace keys from the merge entirely', () => {
    const { container, catalog, contribute } = makeCatalog();
    const userProfile = profile('shared');
    const ownProfile = profile('shared');
    contribute('user', [userProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
    });
    contribute('workspace', [profile('shared')], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.explicit,
      workspaceKey: 'wd_b',
    });
    contribute('workspace', [ownProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get('shared')).toBe(ownProfile);
    expect(catalog.inspect('shared')).toEqual({
      name: 'shared',
      profile: ownProfile,
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      suppressed: [
        { sourceId: 'user', priority: AGENT_PROFILE_SOURCE_PRIORITY.user, reason: 'priority' },
      ],
    });
    catalog.dispose();
    container.dispose();
  });

  it('lets the higher-priority source win a name collision and reports the suppressed candidate', () => {
    const { container, catalog, contribute } = makeCatalog();
    const lowProfile = profile('x');
    const highProfile = profile('x');
    contribute('user', [lowProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.user,
    });
    contribute('workspace', [highProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get('x')).toBe(highProfile);
    expect(catalog.inspect('x')).toEqual({
      name: 'x',
      profile: highProfile,
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      suppressed: [
        { sourceId: 'user', priority: AGENT_PROFILE_SOURCE_PRIORITY.user, reason: 'priority' },
      ],
    });
    catalog.dispose();
    container.dispose();
  });

  it('keeps the builtin profile when a same-name file profile lacks override: true', () => {
    const { container, catalog, contribute } = makeCatalog();
    const builtinProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const fileProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [builtinProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
    });
    contribute('workspace', [fileProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBe(builtinProfile);
    expect(catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)).toEqual({
      name: DEFAULT_AGENT_PROFILE_NAME,
      profile: builtinProfile,
      sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
      priority: AGENT_PROFILE_SOURCE_PRIORITY.builtin,
      suppressed: [
        {
          sourceId: 'workspace',
          priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
          reason: 'builtin-override-required',
        },
      ],
    });
    catalog.dispose();
    container.dispose();
  });

  it('lets a file profile with override: true replace the same-name builtin', () => {
    const { container, catalog, contribute } = makeCatalog();
    const builtinProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const overrideProfile = profile(DEFAULT_AGENT_PROFILE_NAME, { override: true });
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [builtinProfile]);
    contribute('workspace', [overrideProfile], {
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      workspaceKey: 'wd_a',
    });

    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBe(overrideProfile);
    expect(catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)).toEqual({
      name: DEFAULT_AGENT_PROFILE_NAME,
      profile: overrideProfile,
      sourceId: 'workspace',
      priority: AGENT_PROFILE_SOURCE_PRIORITY.workspace,
      suppressed: [],
    });
    catalog.dispose();
    container.dispose();
  });

  it('re-projects and fires the source id on relevant registry changes, ignoring other keys', () => {
    const { container, catalog, contribute } = makeCatalog();
    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));

    const ownProfile = profile('own-ws-p');
    contribute('workspace', [ownProfile], { workspaceKey: 'wd_a' });
    expect(catalog.get('own-ws-p')).toBe(ownProfile);

    const globalProfile = profile('global-p');
    const globalHandle = contribute('user', [globalProfile]);
    expect(catalog.get('global-p')).toBe(globalProfile);

    const otherHandle = contribute('workspace', [profile('other-ws-p')], { workspaceKey: 'wd_b' });
    otherHandle.dispose();
    expect(catalog.get('other-ws-p')).toBeUndefined();

    globalHandle.dispose();
    expect(catalog.get('global-p')).toBeUndefined();

    expect(seen).toEqual(['workspace', 'user', 'user']);
    subscription.dispose();
    catalog.dispose();
    container.dispose();
  });

  it("fires 'catalog' on reload", async () => {
    const { container, catalog } = makeCatalog();
    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));

    await catalog.reload();

    expect(seen).toEqual(['catalog']);
    subscription.dispose();
    catalog.dispose();
    container.dispose();
  });

  it('resolves ready immediately (loader readiness is the workspace handler’s job)', async () => {
    const { container, catalog } = makeCatalog();

    await expect(catalog.ready).resolves.toBeUndefined();
    await expect(catalog.load()).resolves.toBeUndefined();
    catalog.dispose();
    container.dispose();
  });

  it('serves the read surface and throws from getDefault without the default profile', () => {
    const { container, catalog, contribute } = makeCatalog();
    expect(catalog.get('missing')).toBeUndefined();
    expect(catalog.inspect('missing')).toBeUndefined();
    expect(catalog.list()).toEqual([]);
    expect(() => catalog.getDefault()).toThrow(
      `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
    );

    const defaultProfile = profile(DEFAULT_AGENT_PROFILE_NAME);
    const coderProfile = profile('coder');
    contribute(BUILTIN_AGENT_PROFILE_SOURCE_ID, [defaultProfile]);
    contribute('user', [coderProfile]);

    expect(catalog.getDefault()).toBe(defaultProfile);
    expect(catalog.get('coder')).toBe(coderProfile);
    expect(catalog.list()).toEqual([defaultProfile, coderProfile]);
    expect(catalog.inspect(DEFAULT_AGENT_PROFILE_NAME)).toEqual({
      name: DEFAULT_AGENT_PROFILE_NAME,
      profile: defaultProfile,
      sourceId: BUILTIN_AGENT_PROFILE_SOURCE_ID,
      priority: 0,
      suppressed: [],
    });
    catalog.dispose();
    container.dispose();
  });
});
