/**
 * Scenario: structured skill disclosure drives system-reminder freshness.
 *
 * Exercises the real Agent disclosure and reminder services through the
 * harness against a mutable in-memory catalog. The catalog is the only fake
 * boundary; baselines come from typed injection disclosures and the persisted
 * generation-stamped floor. Run:
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/skillDisclosure/skillDisclosure.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSkillDisclosureService } from '#/agent/skillDisclosure/skillDisclosure';

import { stubSkill } from '../../app/skillCatalog/stubs';
import { createTestAgent, skillServices, type TestAgentContext } from '../../harness';
import { runWillBeginStepHooks } from '../loop/stubs';

function skillListReminders(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'skill_list';
  });
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

function systemPromptWithSkills(listing: string): string {
  return `## Available skills\n\n${listing}`;
}

describe('skill disclosure (structured projection and reminder)', () => {
  let catalog: InMemorySkillCatalog;
  let context: IAgentContextMemoryService;
  let ctx: TestAgentContext;
  let disclosure: IAgentSkillDisclosureService;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;

  beforeEach(() => {
    catalog = new InMemorySkillCatalog();
    ctx = createTestAgent(skillServices(catalog));
    context = ctx.get(IAgentContextMemoryService);
    disclosure = ctx.get(IAgentSkillDisclosureService);
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('resolves normalized identities with the matching model listing', async () => {
    catalog.registerBuiltinSkill(stubSkill('Review:Deep', { source: 'builtin' }));

    const snapshot = await disclosure.resolve(true);

    expect(snapshot.names).toEqual(['review:deep']);
    expect(snapshot.listing).toContain('- Review:Deep:');
  });

  it('uses the surviving reminder as the baseline for a structured addition', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    disclosure.markDisclosed((await disclosure.resolve(true)).names, 1);
    catalog.registerBuiltinSkill(stubSkill('namespace:skill-b', { source: 'builtin' }));

    await runWillBeginStepHooks(loop);

    const reminders = skillListReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('- namespace:skill-b:');
    expect(disclosure.disclosedNames()).toEqual(['skill-a']);

    await runWillBeginStepHooks(loop);
    expect(skillListReminders(context)).toHaveLength(1);
  });

  it('reannounces an addition after context clear removes its reminder', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    disclosure.markDisclosed((await disclosure.resolve(true)).names, 1);
    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));
    await runWillBeginStepHooks(loop);

    context.clear();
    await runWillBeginStepHooks(loop);

    const reminders = skillListReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('- skill-b:');
    expect(disclosure.disclosedNames()).toEqual(['skill-a']);
  });

  it('reannounces an addition after undo removes its reminder', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    disclosure.markDisclosed((await disclosure.resolve(true)).names, 1);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'turn' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));
    await runWillBeginStepHooks(loop);

    context.undo(1);
    await runWillBeginStepHooks(loop);

    const reminders = skillListReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('- skill-b:');
    expect(disclosure.disclosedNames()).toEqual(['skill-a']);
  });

  it('adopts the current names silently when no disclosure baseline exists', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));

    await runWillBeginStepHooks(loop);

    expect(skillListReminders(context)).toHaveLength(0);
    expect(disclosure.disclosedNames()).toEqual(['skill-a']);
  });

  it('stays quiet when the active tool policy disables Skill', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    disclosure.markDisclosed((await disclosure.resolve(true)).names, 1);
    profile.update({ disallowedTools: ['Skill'] });
    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));

    await runWillBeginStepHooks(loop);

    expect(skillListReminders(context)).toHaveLength(0);
    expect(disclosure.disclosedNames()).toEqual(['skill-a']);
  });

  it('ignores removals and description-only changes', async () => {
    disclosure.markDisclosed(['skill-a', 'skill-b'], 1);
    catalog.registerBuiltinSkill(
      stubSkill('skill-a', { source: 'builtin', description: 'reworded description' }),
    );

    await runWillBeginStepHooks(loop);

    expect(skillListReminders(context)).toHaveLength(0);
    expect(disclosure.disclosedNames()).toEqual(['skill-a', 'skill-b']);
  });

  it('records a typed disclosure on the fired reminder', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    disclosure.markDisclosed((await disclosure.resolve(true)).names, 1);
    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));

    await runWillBeginStepHooks(loop);

    const reminders = skillListReminders(context);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.origin).toMatchObject({
      kind: 'injection',
      variant: 'skill_list',
      disclosure: {
        kind: 'skills',
        renderGeneration: 1,
        names: ['skill-a', 'skill-b'],
      },
    });
  });

  it('lets a newer render floor supersede a stale in-context reminder', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    disclosure.markDisclosed((await disclosure.resolve(true)).names, 1);
    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));
    await runWillBeginStepHooks(loop);
    expect(skillListReminders(context)).toHaveLength(1);

    catalog.registerBuiltinSkill(stubSkill('skill-c', { source: 'builtin' }));
    disclosure.markDisclosed((await disclosure.resolve(true)).names, 2);
    profile.update({ systemPrompt: systemPromptWithSkills(catalog.getModelSkillListing()) });

    await runWillBeginStepHooks(loop);

    expect(skillListReminders(context)).toHaveLength(1);
  });

  it('reannounces a skill when a newer render repeats the old floor after a stale reminder', async () => {
    catalog.registerBuiltinSkill(stubSkill('skill-a', { source: 'builtin' }));
    catalog.registerBuiltinSkill(stubSkill('skill-b', { source: 'builtin' }));
    disclosure.markDisclosed(['skill-a'], 1);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: catalog.getModelSkillListing() }],
      toolCalls: [],
      origin: {
        kind: 'injection',
        variant: 'skill_list',
        disclosure: {
          kind: 'skills',
          renderGeneration: 1,
          names: ['skill-a', 'skill-b'],
        },
      },
    });
    disclosure.markDisclosed(['skill-a'], 2);

    await runWillBeginStepHooks(loop);

    const reminders = skillListReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1] as ContextMessage)).toContain('- skill-b:');
  });
});
