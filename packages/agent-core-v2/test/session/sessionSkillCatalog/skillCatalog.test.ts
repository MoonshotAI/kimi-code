/**
 * Scenario: the Session-scope skill-catalog view over the seeded workspace data.
 *
 * Exercises `SessionSkillCatalogService` against a controlled
 * `ISessionSkillCatalogData` seed: snapshot forwarding, change-event
 * fan-out, session-local ad-hoc sink contributions, and the no-rescan
 * `reload()`. Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/sessionSkillCatalog/skillCatalog.test.ts`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  _clearScopedRegistryForTests,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog, type ISkillCatalogSink } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';
import { SessionSkillCatalogService } from '#/session/sessionSkillCatalog/skillCatalogService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';

import { stubSkill } from '../../app/skillCatalog/stubs';

function dataSeed(initial: InMemorySkillCatalog): {
  readonly data: ISessionSkillCatalogData;
  readonly changes: Emitter<string>;
  replace(next: InMemorySkillCatalog): void;
} {
  let current: SkillCatalog = initial;
  const changes = new Emitter<string>();
  return {
    changes,
    data: {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: changes.event,
      get catalog() {
        return current;
      },
    },
    replace(next: InMemorySkillCatalog) {
      current = next;
    },
  };
}

function catalogOf(...skills: readonly ReturnType<typeof stubSkill>[]): InMemorySkillCatalog {
  const catalog = new InMemorySkillCatalog();
  for (const skill of skills) catalog.register(skill, { replace: true });
  return catalog;
}

describe('SessionSkillCatalogService (seed view)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionStateService,
      SessionStateService,
    );
    registerScopedService(LifecycleScope.Session, ISessionSkillCatalog, SessionSkillCatalogService);
  });

  function makeSession(data: ISessionSkillCatalogData) {
    const host = createScopedTestHost([]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionSkillCatalogData, data),
    ]);
    return { host, catalog: session.accessor.get(ISessionSkillCatalog) };
  }

  it('exposes the seeded snapshot after ready', async () => {
    const seed = dataSeed(catalogOf(stubSkill('from-workspace')));
    const { host, catalog } = makeSession(seed.data);

    await catalog.load();
    expect(catalog.catalog.getSkill('from-workspace')).toBeDefined();
    host.dispose();
  });

  it('re-folds and forwards the source id when the seed fires a change', async () => {
    const seed = dataSeed(catalogOf(stubSkill('before')));
    const { host, catalog } = makeSession(seed.data);
    await catalog.load();

    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));
    seed.replace(catalogOf(stubSkill('after')));
    seed.changes.fire('workspace');

    expect(catalog.catalog.getSkill('before')).toBeUndefined();
    expect(catalog.catalog.getSkill('after')).toBeDefined();
    expect(seen).toEqual(['workspace']);
    subscription.dispose();
    host.dispose();
  });

  it('merges ad-hoc sink contributions over the seed and drops them on remove', async () => {
    const seed = dataSeed(catalogOf(stubSkill('shared', { description: 'from workspace' })));
    const { host, catalog } = makeSession(seed.data);
    await catalog.load();

    const sink = catalog as unknown as ISkillCatalogSink;
    sink.set(
      'adhoc',
      { skills: [stubSkill('shared', { description: 'from adhoc' }), stubSkill('adhoc-only')] },
      { priority: 40 },
    );
    expect(catalog.catalog.getSkill('shared')?.description).toBe('from adhoc');
    expect(catalog.catalog.getSkill('adhoc-only')).toBeDefined();

    sink.remove('adhoc');
    expect(catalog.catalog.getSkill('shared')?.description).toBe('from workspace');
    expect(catalog.catalog.getSkill('adhoc-only')).toBeUndefined();
    host.dispose();
  });

  it('reload re-folds the current seed without rescanning and fires catalog', async () => {
    const seed = dataSeed(catalogOf(stubSkill('one')));
    const { host, catalog } = makeSession(seed.data);
    await catalog.load();

    // A silent seed swap (no change event) becomes visible through reload.
    seed.replace(catalogOf(stubSkill('two')));
    const seen: string[] = [];
    const subscription = catalog.onDidChange((sourceId) => seen.push(sourceId));
    await catalog.reload();

    expect(catalog.catalog.getSkill('two')).toBeDefined();
    expect(seen).toEqual(['catalog']);
    subscription.dispose();
    host.dispose();
  });
});
