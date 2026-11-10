import { mkdtemp, rm } from 'node:fs/promises';
import { appendContext } from '../../agent/contextMemory/stubs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  AgentDateChangeService,
  IAgentDateChangeService,
} from '#/features/dateChange/dateChangeService';
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

function updateSystemPrompt(profile: IAgentLoopService, systemPrompt: string, cwd: string): void {
  profile.update({
    systemPrompt,
    environmentDisclosure: { cwd },
  });
}

function dateReminders(context: IAgentLoopService): readonly ContextMessage[] {
  return context.history().filter((message) => {
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
  let context: IAgentLoopService;
  let clock: TestHostClock;
  let loop: IAgentLoopService;
  let profile: IAgentLoopService;

  beforeEach(async () => {
    clock = testHostClock(INITIAL_INSTANT);
    ctx = createTestAgent({ autoConfigure: false }, appService(IHostClock, clock));
    context = ctx.get(IAgentLoopService);
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentLoopService);
    await ctx.restorePersisted();
    ctx.configure();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('injects on the first step even when the system prompt text states today\'s date', async () => {
    updateSystemPrompt(profile, systemPromptWithDate(INITIAL_INSTANT), ctx.get(ISessionContext).cwd);

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('2026-07-29');
  });

  it('discloses the current date and stays quiet when the system prompt text is stale', async () => {
    updateSystemPrompt(
      profile,
      systemPromptWithDate('2026-07-28T04:00:00.000Z'),
      ctx.get(ISessionContext).cwd,
    );

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    const first = reminders[0];
    expect(first).toBeDefined();
    const text = messageText(first as ContextMessage);
    expect(text).toContain("Today's date is 2026-07-29");
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
    updateSystemPrompt(profile, systemPromptWithDate(INITIAL_INSTANT), ctx.get(ISessionContext).cwd);
    await runWillBeginStepHooks(loop);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    let reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1] as ContextMessage)).toContain('2026-07-30');

    clock.set('2026-07-31T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    reminders = dateReminders(context);
    expect(reminders).toHaveLength(3);
    expect(messageText(reminders[2] as ContextMessage)).toContain('2026-07-31');
    expect(reminders[2]?.origin).toMatchObject({
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
    profile = ctx.get(IAgentLoopService);
    updateSystemPrompt(profile, systemPromptWithDate(INITIAL_INSTANT), ctx.get(ISessionContext).cwd);
    await ctx.wire.flush();
    await ctx.dispose();

    clock.set('2026-07-30T04:00:00.000Z');
    ctx = createTestAgent(
      { autoConfigure: false, persistence },
      appService(IHostClock, clock),
    );
    context = ctx.get(IAgentLoopService);
    loop = ctx.get(IAgentLoopService);
    await ctx.restorePersisted();

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('2026-07-30');
  });

  it('discloses the current date after resuming a legacy profile without disclosure metadata', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    await ctx.dispose();
    ctx = createTestAgent({ persistence }, appService(IHostClock, clock));
    profile = ctx.get(IAgentLoopService);
    await profile.applyBindingSnapshot({
      modelAlias: 'mock-model',
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: systemPromptWithDate(INITIAL_INSTANT),
      disallowedTools: [],
    });
    await ctx.wire.flush();
    const legacyBind = persistence.records.findLast((record) => record.type === 'profile.bind');
    expect(legacyBind?.['environmentDisclosure']).toBeUndefined();
    await ctx.dispose();

    clock.set('2026-07-30T04:00:00.000Z');
    ctx = createTestAgent(
      { autoConfigure: false, persistence },
      appService(IHostClock, clock),
    );
    context = ctx.get(IAgentLoopService);
    loop = ctx.get(IAgentLoopService);
    await ctx.restorePersisted();

    await runWillBeginStepHooks(loop);
    const initial = dateReminders(context);
    expect(initial).toHaveLength(1);
    expect(messageText(initial[0] as ContextMessage)).toContain('2026-07-30');

    clock.set('2026-07-31T04:00:00.000Z');
    await runWillBeginStepHooks(loop);
    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1] as ContextMessage)).toContain('2026-07-31');
  });

  it('announces a crossed midnight through a real bind rendered from the host clock', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-date-bind-home-'));
    try {
      await ctx.dispose();
      ctx = createTestAgent(appService(IHostClock, clock), hostEnvironmentServices(homeDir));
      context = ctx.get(IAgentLoopService);
      loop = ctx.get(IAgentLoopService);
      profile = ctx.get(IAgentLoopService);
        await ctx.restorePersisted();

      await profile.bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'mock-model' });

      await runWillBeginStepHooks(loop);
      const initial = dateReminders(context);
      expect(initial).toHaveLength(1);
      expect(messageText(initial[0] as ContextMessage)).toContain('2026-07-29');

      clock.set('2026-07-30T04:00:00.000Z');
      await runWillBeginStepHooks(loop);

      const reminders = dateReminders(context);
      expect(reminders).toHaveLength(2);
      expect(messageText(reminders[1] as ContextMessage)).toContain('2026-07-30');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('keeps the newer render-generation disclosure when an older metadata reminder appears later', async () => {
    updateSystemPrompt(
      profile,
      'You are a deterministic test agent.',
      ctx.get(ISessionContext).cwd,
    );

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);

    appendContext(context,{
      role: 'user',
      content: [{ type: 'text', text: 'older metadata reminder' }],
      origin: {
        kind: 'injection',
        variant: 'date_change',
        disclosure: {
          kind: 'date',
          renderGeneration: 1,
          localDate: '2026-07-30',
          timeZone: TEST_TIME_ZONE,
        },
      },
    });

    await runWillBeginStepHooks(loop);

    expect(dateReminders(context)).toHaveLength(2);
  });

  it('keeps the structured reminder metadata exactly once across undo and the next step', async () => {
    updateSystemPrompt(
      profile,
      'You are a deterministic test agent.',
      ctx.get(ISessionContext).cwd,
    );
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first turn' }] });
    await ctx.untilTurnEnd();
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);

    await ctx.get(IAgentConversationUndoService).undo(1);
    expect(dateReminders(context)).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'replacement answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'replacement turn' }] });
    await ctx.untilTurnEnd();

    await runWillBeginStepHooks(loop);

    expect(dateReminders(context)).toHaveLength(1);
  });

  it('keeps the initial date disclosure across undo and the next step', async () => {
    updateSystemPrompt(
      profile,
      'You are a deterministic test agent.',
      ctx.get(ISessionContext).cwd,
    );
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first turn' }] });
    await ctx.untilTurnEnd();
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);

    await ctx.get(IAgentConversationUndoService).undo(1);
    expect(dateReminders(context)).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'replacement answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'replacement turn' }] });
    await ctx.untilTurnEnd();

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('2026-07-29');
  });

  it('discloses the current date on the first step and stays quiet', async () => {
    updateSystemPrompt(
      profile,
      'You are a deterministic test agent.',
      ctx.get(ISessionContext).cwd,
    );

    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(1);
    expect(messageText(reminders[0] as ContextMessage)).toContain('2026-07-29');
    expect(reminders[0]?.origin).toMatchObject({
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

  it('announces a crossed midnight after the initial disclosure', async () => {
    updateSystemPrompt(
      profile,
      'You are a deterministic test agent.',
      ctx.get(ISessionContext).cwd,
    );
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1] as ContextMessage)).toContain('2026-07-30');

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(2);
  });

  it('discloses then announces when the snapshot cwd is empty', async () => {
    updateSystemPrompt(profile, 'You are a deterministic test agent.', '');
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    expect(messageText(reminders[1] as ContextMessage)).toContain('2026-07-30');
  });

  it('never injects when the snapshot belongs to a different cwd', async () => {
    updateSystemPrompt(profile, 'You are a deterministic test agent.', '/some/other/workspace');

    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(0);
  });

  it('keeps one provider registration across repeated restore', async () => {
    updateSystemPrompt(
      profile,
      'You are a deterministic test agent.',
      ctx.get(ISessionContext).cwd,
    );

    expect(ctx.get(IAgentDateChangeService)).toBeInstanceOf(AgentDateChangeService);
    await runWillBeginStepHooks(loop);
    expect(dateReminders(context)).toHaveLength(1);

    await ctx.restorePersisted();
    await ctx.restorePersisted();
    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    expect(dateReminders(context)).toHaveLength(2);
  });

  it('labels the disclosure and change reminders with the local client timezone', async () => {
    updateSystemPrompt(
      profile,
      'You are a deterministic test agent.',
      ctx.get(ISessionContext).cwd,
    );
    await runWillBeginStepHooks(loop);

    const initial = dateReminders(context);
    expect(initial).toHaveLength(1);
    const initialText = messageText(initial[0] as ContextMessage);
    expect(initialText).toContain('2026-07-29');
    expect(initialText).toContain(TEST_TIME_ZONE);
    expect(initialText).toContain('local client');

    clock.set('2026-07-30T04:00:00.000Z');
    await runWillBeginStepHooks(loop);

    const reminders = dateReminders(context);
    expect(reminders).toHaveLength(2);
    const changeText = messageText(reminders[1] as ContextMessage);
    expect(changeText).toContain('2026-07-30');
    expect(changeText).toContain(TEST_TIME_ZONE);
    expect(changeText).toContain('local client');
  });
});
