import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FiberState } from '#/_base/di/fiber';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  type EnvironmentDisclosureSnapshot,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IAgentDateChangeService } from '#/features/dateChange/dateChange';
import { DateChangeFeature } from '#/features/dateChange/dateChangeFeature';
import { dateChangeSeedKey } from '#/features/dateChange/dateChangeService';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  appService,
  createTestAgent,
  hostEnvironmentServices,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';
import { runWillBeginStepHooks } from '../../agent/loop/stubs';

const TEST_TIME_ZONE = 'Asia/Shanghai';
const INITIAL_INSTANT = '2026-07-29T04:00:00.000Z';

interface TestHostClock extends IHostClock {
  set(iso: string): void;
}

function testHostClock(initialIso: string): TestHostClock {
  let current = new Date(initialIso);
  return {
    _serviceBrand: undefined,
    now: () => new Date(current),
    timeZone: () => TEST_TIME_ZONE,
    set: (iso) => {
      current = new Date(iso);
    },
  };
}

function systemPromptWithDate(iso: string): string {
  return [
    'You are a deterministic test agent.',
    '',
    `The current date and time in ISO format is \`${iso}\`. This was captured when the session started and does not update.`,
  ].join('\n');
}

function updateSystemPromptWithDate(
  profile: IAgentProfileService,
  cwd: string,
  iso: string,
  localDate: string,
): void {
  const environment: EnvironmentDisclosureSnapshot = {
    cwd,
    date: {
      disclosed: true,
      value: {
        localDate,
        timeZone: TEST_TIME_ZONE,
      },
    },
  };
  profile.update({
    systemPrompt: systemPromptWithDate(iso),
    environmentDisclosure: environment,
  });
}

function updateSystemPromptWithoutDate(profile: IAgentProfileService, cwd: string): void {
  const environment: EnvironmentDisclosureSnapshot = {
    cwd,
    date: { disclosed: false },
  };
  profile.update({
    systemPrompt: 'You are a deterministic test agent.',
    environmentDisclosure: environment,
  });
}

function dateReminders(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'date_change';
  });
}

function messageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('AgentDateChangeService', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let clock: TestHostClock;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;

  beforeEach(() => {
    clock = testHostClock(INITIAL_INSTANT);
    ctx = createTestAgent(appService(IHostClock, clock));
    context = ctx.get(IAgentContextMemoryService);
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

  it('does not inject when the system prompt date is today', async () => {
    updateSystemPromptWithDate(
      profile,
      ctx.get(ISessionContext).cwd,
      INITIAL_INSTANT,
      '2026-07-29',
    );

    await runWillBeginStepHooks(loop);

    expect(dateReminders(context)).toHaveLength(0);
  });

  it('injects once when the rendered date is stale, then stays quiet', async () => {
    updateSystemPromptWithDate(
      profile,
      ctx.get(ISessionContext).cwd,
      '2026-07-28T04:00:00.000Z',
      '2026-07-28',
    );

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    const text = messageText(first as ContextMessage);
    expect(text).toContain("Today's date is now 2026-07-29");
    expect(text).toContain('stale');
    expect(text).toContain('DO NOT mention this to the user explicitly');
    expect(first?.origin).toMatchObject({
      kind: 'injection',
      variant: 'date_change',
      disclosure: {
        kind: 'date',
        renderGeneration: 2,
        localDate: '2026-07-29',
        timeZone: TEST_TIME_ZONE,
      },
    });

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);
  });

  it('announces each date crossed by a long-lived session', async () => {
    updateSystemPromptWithDate(
      profile,
      ctx.get(ISessionContext).cwd,
      INITIAL_INSTANT,
      '2026-07-29',
    );
    await runWillBeginStepHooks(loop);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    let reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-30",
    );

    clock.set('2026-07-31T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1] as ContextMessage)).toContain(
      "Today's date is now 2026-07-31",
    );
    expect(reminders[1]?.origin).toMatchObject({
      disclosure: {
        kind: 'date',
        renderGeneration: 2,
        localDate: '2026-07-31',
      },
    });
  });

  it('injects on the first step when a persisted prompt crosses midnight before resume', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    await ctx.dispose();
    ctx = createTestAgent({ persistence }, appService(IHostClock, clock));
    profile = ctx.get(IAgentProfileService);
    updateSystemPromptWithDate(
      profile,
      ctx.get(ISessionContext).cwd,
      INITIAL_INSTANT,
      '2026-07-29',
    );
    await ctx.wire.flush();
    await ctx.dispose();

    clock.set('2026-07-30T04:00:00.000Z');
    ctx = createTestAgent(
      { autoConfigure: false, persistence },
      appService(IHostClock, clock),
    );
    context = ctx.get(IAgentContextMemoryService);
    loop = ctx.get(IAgentLoopService);
    await ctx.restorePersisted();

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-30",
    );
  });

  it('seeds and announces after resuming a legacy profile without disclosure metadata', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    await ctx.dispose();
    ctx = createTestAgent({ persistence }, appService(IHostClock, clock));
    profile = ctx.get(IAgentProfileService);
    profile.applyBindingSnapshot({
      modelAlias: 'mock-model',
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: systemPromptWithDate(INITIAL_INSTANT),
      disallowedTools: [],
    });
    await ctx.wire.flush();
    const legacyBind = persistence.records.find((record) => record.type === 'profile.bind');
    expect(legacyBind?.['environmentDisclosure']).toBeUndefined();
    await ctx.dispose();

    clock.set('2026-07-30T04:00:00.000Z');
    ctx = createTestAgent(
      { autoConfigure: false, persistence },
      appService(IHostClock, clock),
    );
    context = ctx.get(IAgentContextMemoryService);
    loop = ctx.get(IAgentLoopService);
    await ctx.restorePersisted();

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);

    clock.set('2026-07-31T04:00:00.000Z');
    await runWillBeginStepHooks(loop);
    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-31",
    );
  });

  it('announces a crossed midnight through a real bind rendered from the host clock', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-date-bind-home-'));
    try {
      await ctx.dispose();
      ctx = createTestAgent(appService(IHostClock, clock), hostEnvironmentServices(homeDir));
      context = ctx.get(IAgentContextMemoryService);
      loop = ctx.get(IAgentLoopService);
      profile = ctx.get(IAgentProfileService);

      await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'mock-model' });

      await runWillBeginStepHooks(loop);
      expect(dateReminders(context)).toHaveLength(0);

      clock.set('2026-07-30T04:00:00.000Z');
      await runWillBeginStepHooks(loop);

      const reminders = dateReminders(context);
      expect(reminders).toHaveLength(1);
      expect(messageText(reminders[0] as ContextMessage)).toContain(
        "Today's date is now 2026-07-30",
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses the newer persisted render snapshot over older reminder metadata', async () => {
    updateSystemPromptWithDate(
      profile,
      ctx.get(ISessionContext).cwd,
      '2026-07-28T04:00:00.000Z',
      '2026-07-28',
    );
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'older date reminder' }],
      toolCalls: [],
      origin: {
        kind: 'injection',
        variant: 'date_change',
        disclosure: {
          kind: 'date',
          renderGeneration: 1,
          localDate: '2026-07-29',
          timeZone: TEST_TIME_ZONE,
        },
      },
    });

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(reminders.at(-1)?.origin).toMatchObject({
      disclosure: {
        kind: 'date',
        renderGeneration: 2,
        localDate: '2026-07-29',
      },
    });
  });

  it('re-injects after undo removes the structured reminder metadata', async () => {
    updateSystemPromptWithDate(
      profile,
      ctx.get(ISessionContext).cwd,
      '2026-07-28T04:00:00.000Z',
      '2026-07-28',
    );
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'first turn' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);

    expect(context.undo(1)).toMatchObject({ removedCount: 1 });
    expect(dateReminders(context)).toHaveLength(0);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'replacement turn' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    await runWillBeginStepHooks(loop);

    expect(dateReminders(context)).toHaveLength(1);
  });

  it('adopts today silently when the system prompt carries no date line', async () => {
    updateSystemPromptWithoutDate(profile, ctx.get(ISessionContext).cwd);

    await runWillBeginStepHooks(loop);

    expect(dateReminders(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('announces a crossed midnight after the silent seed', async () => {
    updateSystemPromptWithoutDate(profile, ctx.get(ISessionContext).cwd);
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-30",
    );

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);
  });

  it('treats an empty snapshot cwd as unknown and uses the disclosed date as baseline', async () => {
    updateSystemPromptWithDate(profile, '', '2026-07-28T04:00:00.000Z', '2026-07-28');

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-29",
    );
  });

  it('seeds quietly then announces when the snapshot cwd is empty and no date is disclosed', async () => {
    updateSystemPromptWithoutDate(profile, '');
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-30",
    );
  });

  it('never injects when the snapshot belongs to a different cwd', async () => {
    updateSystemPromptWithDate(
      profile,
      '/some/other/workspace',
      '2026-07-28T04:00:00.000Z',
      '2026-07-28',
    );

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);
  });

  it('withdraws and restores the eager service, provider, and seed with the Feature', async () => {
    const manager = ctx.get(IFeatureManager);
    const states = ctx.get(IAgentStateService);
    updateSystemPromptWithoutDate(profile, ctx.get(ISessionContext).cwd);

    expect(manager.units().find((unit) => unit.name === 'dateChange')?.state).toBe(
      FiberState.Active,
    );
    expect(ctx.get(IAgentDateChangeService)).toBeDefined();
    expect(states.has(dateChangeSeedKey)).toBe(true);
    await runWillBeginStepHooks(loop);
    expect(states.get(dateChangeSeedKey)).toMatchObject({ localDate: '2026-07-29' });

    await manager.unprovideUnit('dateChange');
    expect(() => ctx.get(IAgentDateChangeService)).toThrow();
    expect(states.has(dateChangeSeedKey)).toBe(false);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);

    manager.provideUnit(DateChangeFeature);
    expect(ctx.get(IAgentDateChangeService)).toBeDefined();
    expect(states.has(dateChangeSeedKey)).toBe(true);
    expect(states.get(dateChangeSeedKey)).toBeUndefined();

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);
    expect(states.get(dateChangeSeedKey)).toMatchObject({ localDate: '2026-07-30' });

    clock.set('2026-07-31T04:00:00.000Z');
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);
    expect(messageText(dateReminders(context)[0] as ContextMessage)).toContain(
      "Today's date is now 2026-07-31",
    );
  });
});
