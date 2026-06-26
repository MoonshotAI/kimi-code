import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/contextMemory';
import { IEventBus } from '#/eventBus';
import { IPromptService } from '#/prompt';
import { IAgentSkillService } from '#/skill';
import { AgentSkillService } from '#/skill/skillService';
import type { SkillCatalog, SkillDefinition } from '#/skill/types';
import { ITelemetryService } from '#/telemetry';
import type { Turn } from '#/turn';
import { IWireRecord } from '#/wireRecord';
import { stubWireRecord } from '../contextMemory/stubs';

// NOTE: the legacy `SkillRegistry` / `ISkillRegistry` and `SkillService` /
// `ISkillService` (whose `activate(name)` pushed onto `ITurnService.prompts`)
// no longer exist in HEAD. Skill activation is now owned by `AgentSkillService`
// (`IAgentSkillService`), which resolves the skill from an injected
// `SkillCatalog` and delivers it through `IPromptService.prompt`. The registry
// suite has no HEAD equivalent and was dropped; the activation cases below
// assert on the prompt delivery instead of the removed turn queue.

const COMMIT_SKILL: SkillDefinition = {
  name: 'commit',
  description: 'commit changes',
  path: '/skills/commit/SKILL.md',
  dir: '/skills/commit',
  content: '# Commit',
  metadata: {},
  source: 'user',
};

function stubCatalog(skills: readonly SkillDefinition[]): SkillCatalog {
  return {
    getSkill: (name) => skills.find((s) => s.name === name),
    getPluginSkill: () => undefined,
    renderSkillPrompt: () => 'rendered skill body',
    listInvocableSkills: () => [...skills],
    getSkillRoots: () => [],
    getModelSkillListing: () => '',
  };
}

function fakeTurn(): Turn {
  return {
    id: 1,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
  };
}

describe('AgentSkillService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let prompted: ContextMessage[];

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    prompted = [];
    ix.stub(IPromptService, {
      prompt: (message) => {
        prompted.push(message);
        return fakeTurn();
      },
      steer: () => undefined,
      retry: () => undefined,
      undo: () => 0,
      clear: () => {},
    });
    ix.stub(IEventBus, { emit: () => {}, on: () => ({ dispose: () => {} }) });
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(ITelemetryService, { track: () => {} });
    ix.set(
      IAgentSkillService,
      new SyncDescriptor(AgentSkillService, [{ catalog: stubCatalog([COMMIT_SKILL]) }]),
    );
  });
  afterEach(() => disposables.dispose());

  it('activate prompts with the rendered skill for a known skill', () => {
    const svc = ix.get(IAgentSkillService);
    const turn = svc.activate({ name: 'commit' });

    expect(turn).toBeDefined();
    expect(prompted).toHaveLength(1);
    expect(prompted[0]!.role).toBe('user');
    expect(prompted[0]!.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
    });
  });

  it('activate throws for an unknown skill', () => {
    const svc = ix.get(IAgentSkillService);
    expect(() => svc.activate({ name: 'missing' })).toThrow(/not found/i);
  });
});
