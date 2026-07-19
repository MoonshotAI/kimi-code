/**
 * `profile` domain (L4) — `AgentSkillListingReminderService` unit tests.
 *
 * Asserts the turn-boundary injection semantics of the skill-catalog change
 * reminder: exactly one reminder per catalog change burst, only at new turns,
 * carrying the change note, the DISREGARD line, and the refreshed listing.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/profile/agentSkillListingReminder.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import {
  IAgentContextInjectorService,
  type ContextInjectionProvider,
} from '#/agent/contextInjector/contextInjector';
import { AgentSkillListingReminderService } from '#/agent/profile/agentSkillListingReminderService';
import {
  IAgentSkillListingReminderService,
  SKILL_CATALOG_CHANGED_INJECTION_VARIANT,
} from '#/agent/profile/agentSkillListingReminder';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { stubSkill } from '../../app/skillCatalog/stubs';

function skillCatalogStub(skills: readonly SkillDefinition[]): {
  readonly stub: ISessionSkillCatalog;
  readonly emitter: Emitter<string>;
} {
  const catalog = new InMemorySkillCatalog();
  for (const skill of skills) catalog.register(skill, { replace: true });
  const emitter = new Emitter<string>();
  return {
    emitter,
    stub: {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: emitter.event,
      load: async () => {},
      reload: async () => {},
    },
  };
}

function injectorStub(): {
  readonly stub: IAgentContextInjectorService;
  readonly providers: Map<string, ContextInjectionProvider>;
} {
  const providers = new Map<string, ContextInjectionProvider>();
  return {
    providers,
    stub: {
      _serviceBrand: undefined,
      register: (name: string, provider: ContextInjectionProvider) => {
        providers.set(name, provider);
        return toDisposable(() => {
          if (providers.get(name) === provider) providers.delete(name);
        });
      },
      injectAfterCompaction: async () => {},
    },
  };
}

function isNewTurn(): { injectedPositions: number[]; lastInjectedAt: null; isNewTurn: true } {
  return { injectedPositions: [], lastInjectedAt: null, isNewTurn: true };
}

function notNewTurn(): { injectedPositions: number[]; lastInjectedAt: null; isNewTurn: false } {
  return { injectedPositions: [], lastInjectedAt: null, isNewTurn: false };
}

describe('AgentSkillListingReminderService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let catalog: ReturnType<typeof skillCatalogStub>;
  let injector: ReturnType<typeof injectorStub>;

  beforeEach(() => {
    disposables = new DisposableStore();
    catalog = skillCatalogStub([stubSkill('hot-skill')]);
    injector = injectorStub();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ISessionSkillCatalog, catalog.stub);
        reg.defineInstance(IAgentContextInjectorService, injector.stub);
        reg.define(IAgentSkillListingReminderService, AgentSkillListingReminderService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function provider(): ContextInjectionProvider {
    const registered = injector.providers.get(SKILL_CATALOG_CHANGED_INJECTION_VARIANT);
    expect(registered).toBeDefined();
    return registered!;
  }

  it('registers the skill_catalog_changed provider into the agent injector', () => {
    ix.get(IAgentSkillListingReminderService);
    expect(injector.providers.has(SKILL_CATALOG_CHANGED_INJECTION_VARIANT)).toBe(true);
  });

  it('stays silent until the catalog changes at a new turn', async () => {
    ix.get(IAgentSkillListingReminderService);
    expect(await provider()(isNewTurn())).toBeUndefined();

    catalog.emitter.fire('user');
    expect(await provider()(notNewTurn())).toBeUndefined();

    const reminder = await provider()(isNewTurn());
    expect(reminder).toBeDefined();
    expect(reminder).toContain('The skill catalog changed during this session');
    expect(reminder).toContain('DISREGARD any earlier skill listings');
    expect(reminder).toContain('hot-skill');
  });

  it('does not re-inject on a later new turn without a new change', async () => {
    ix.get(IAgentSkillListingReminderService);
    catalog.emitter.fire('user');
    expect(await provider()(isNewTurn())).toBeDefined();
    expect(await provider()(isNewTurn())).toBeUndefined();
  });

  it('injects once per catalog change burst and again after the next change', async () => {
    ix.get(IAgentSkillListingReminderService);
    catalog.emitter.fire('user');
    catalog.emitter.fire('workspace');
    expect(await provider()(isNewTurn())).toBeDefined();
    expect(await provider()(isNewTurn())).toBeUndefined();

    catalog.emitter.fire('extra');
    expect(await provider()(isNewTurn())).toBeDefined();
  });

  it('reports when no invocable skills remain', async () => {
    disposables.dispose();
    disposables = new DisposableStore();
    catalog = skillCatalogStub([]);
    injector = injectorStub();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ISessionSkillCatalog, catalog.stub);
        reg.defineInstance(IAgentContextInjectorService, injector.stub);
        reg.define(IAgentSkillListingReminderService, AgentSkillListingReminderService);
      },
    });
    ix.get(IAgentSkillListingReminderService);

    catalog.emitter.fire('user');
    const reminder = await provider()(isNewTurn());
    expect(reminder).toBeDefined();
    expect(reminder).toContain('The skill catalog changed during this session');
    expect(reminder).toContain('no invocable skills');
  });
});
