/**
 * Scenario: the Session-scope agent-profile-catalog view over the seeded
 * workspace data.
 *
 * Exercises `SessionAgentProfileCatalogService` against a controlled
 * `ISessionAgentProfileCatalogData` seed: read delegation, readiness
 * propagation (including fatal explicit-file rejections), change-event
 * fan-out, and the no-rescan `reload()`. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog.test.ts`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalogData } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogData';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { SessionAgentProfileCatalogService } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';

const DEFAULT_PROFILE: AgentProfile = {
  name: DEFAULT_AGENT_PROFILE_NAME,
  systemPrompt: () => 'default',
};

function dataSeed(opts: {
  readonly profiles?: readonly AgentProfile[];
  readonly ready?: Promise<void>;
}): {
  readonly data: ISessionAgentProfileCatalogData;
  readonly changes: Emitter<string>;
} {
  const profiles = opts.profiles ?? [DEFAULT_PROFILE];
  const changes = new Emitter<string>();
  return {
    changes,
    data: {
      _serviceBrand: undefined,
      ready: opts.ready ?? Promise.resolve(),
      onDidChange: changes.event,
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => {
        const profile = profiles.find((candidate) => candidate.name === DEFAULT_AGENT_PROFILE_NAME);
        if (profile === undefined) throw new Error('no default');
        return profile;
      },
      list: () => profiles,
    },
  };
}

describe('SessionAgentProfileCatalogService (seed view)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionAgentProfileCatalog,
      SessionAgentProfileCatalogService,
    );
  });

  function makeSession(data: ISessionAgentProfileCatalogData) {
    const host = createScopedTestHost([]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionAgentProfileCatalogData, data),
    ]);
    return { host, catalog: session.accessor.get(ISessionAgentProfileCatalog) };
  }

  it('delegates reads to the seed', async () => {
    const seed = dataSeed({
      profiles: [DEFAULT_PROFILE, { name: 'coder', systemPrompt: () => 'coder' }],
    });
    const { host, catalog } = makeSession(seed.data);

    await catalog.load();
    expect(catalog.get('coder')?.name).toBe('coder');
    expect(catalog.getDefault().name).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(catalog.list().map((profile) => profile.name)).toEqual([
      DEFAULT_AGENT_PROFILE_NAME,
      'coder',
    ]);
    host.dispose();
  });

  it('propagates a rejecting seed readiness (fatal explicit source)', async () => {
    const failure = new Error('invalid --agent-file');
    const seed = dataSeed({ ready: Promise.reject(failure) });
    // Mirror the production service: an un-awaited rejection must not crash.
    void seed.data.ready.catch(() => undefined);
    const { host, catalog } = makeSession(seed.data);

    await expect(catalog.load()).rejects.toThrow('invalid --agent-file');
    host.dispose();
  });

  it('forwards change events with their source id and fires catalog on reload', async () => {
    const seed = dataSeed({});
    const { host, catalog } = makeSession(seed.data);
    await catalog.load();

    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));
    seed.changes.fire('project');
    await catalog.reload();

    expect(seen).toEqual(['project', 'catalog']);
    subscription.dispose();
    host.dispose();
  });
});
