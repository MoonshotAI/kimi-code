import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it, vi } from 'vitest';

import {
  WIRE_PROTOCOL_VERSION,
  IAgentGoalService,
  type WireRecord,
  type PromptOrigin,
} from '#/index';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { TurnModel } from '#/agent/loop/turnOps';
import { IWireService } from '#/wire/wire';
import {
  createAgentTaskPersistence,
  type TaskServiceTestManager,
} from '../agent/task/stubs';
import { createFakeHostFs, createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import {
  DEFAULT_TEST_SYSTEM_PROMPT,
  InMemoryWireRecordPersistence,
  execEnvServices,
  homeDirServices,
  testAgent,
} from '../harness';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

function turnCurrentId(ctx: ReturnType<typeof testAgent>): number {
  return ctx.get(IWireService).getModel(TurnModel).nextTurnId - 1;
}

describe('Agent resume', () => {
  it('does not append metadata when resuming records that include legacy app version', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
        app_version: '0.0.1-old',
      } as unknown as WireRecord,
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'old prompt' }],
        origin: { kind: 'user' },
      } as unknown as WireRecord,
    ]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(persistence.appended).toEqual([]);
    expect(persistence.records.filter((record) => record.type === 'metadata')).toHaveLength(1);
  });

  it('replays persisted records without restarting turns, compactions, plan turns, or tools', async () => {
    const persistence = new RecordingAgentPersistence(resumeHistory() as unknown as WireRecord[]);
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute on resume'));
    const ctx = testAgent(
      execEnvServices({
        hostFs: createFakeHostFs({ readText: vi.fn().mockResolvedValue('') }),
        processRunner: createFakeProcessRunner({ exec: execWithEnv }),
      }),
      { autoConfigure: false, persistence },
    );

    await ctx.restorePersisted();
    const plan = await ctx.get(IAgentPlanService).status();
    expect(plan?.path).toContain('resume-plan');
    expect(ctx.newEvents()).toMatchInlineSnapshot(`[]`);
    expect(ctx.llmCalls).toHaveLength(0);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(persistence.appended).toEqual([]);
    await ctx.expectResumeMatches();

    ctx.mockNextResponse({ type: 'text', text: 'Fresh response after resume.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fresh prompt after resume' }] });
    await ctx.untilTurnEnd();

    expect(findRpcEvent(ctx.allEvents, 'turn.started')?.args).toMatchObject({
      turnId: 1,
    });
    expect(findRpcEvent(ctx.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 1,
      reason: 'completed',
    });
    expect(findRpcEvent(ctx.allEvents, 'error')).toBeUndefined();
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Historical compacted summary."
          user: text "Fresh prompt after resume"
          user: text <plan-mode-reminder>
    `);
  });

  it('allocates monotonically increasing turnIds across multiple historical turns on resume', async () => {
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory() as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(turnCurrentId(ctx)).toBe(1);

    ctx.mockNextResponse({ type: 'text', text: 'Fresh response.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fresh prompt' }] });
    await ctx.untilTurnEnd();

    expect(findRpcEvent(ctx.allEvents, 'turn.started')?.args).toMatchObject({ turnId: 2 });
    expect(findRpcEvent(ctx.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 2,
      reason: 'completed',
    });
  });

  it('restores the turn counter past goal-continuation turns that have no turn.prompt record', async () => {
    const persistence = new RecordingAgentPersistence(goalContinuationResumeHistory() as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(turnCurrentId(ctx)).toBe(2);

    ctx.mockNextResponse({ type: 'text', text: 'Fresh response after goal resume.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fresh prompt after goal' }] });
    await ctx.untilTurnEnd();

    expect(findRpcEvent(ctx.allEvents, 'turn.started')?.args).toMatchObject({ turnId: 3 });
    expect(findRpcEvent(ctx.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 3,
      reason: 'completed',
    });
  });

  it('keeps turnIds monotonic across repeated resume cycles', async () => {
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory() as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();
    ctx.mockNextResponse({ type: 'text', text: 'Response in cycle 1.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Prompt in cycle 1' }] });
    await ctx.untilTurnEnd();
    expect(turnCurrentId(ctx)).toBe(2);

    const persistence2 = new RecordingAgentPersistence(persistence.records as unknown as WireRecord[]);
    const ctx2 = testAgent({ persistence: persistence2, autoConfigure: false });

    await ctx2.restorePersisted();
    expect(turnCurrentId(ctx2)).toBe(2);

    ctx2.mockNextResponse({ type: 'text', text: 'Response in cycle 2.' });
    await ctx2.rpc.prompt({ input: [{ type: 'text', text: 'Prompt in cycle 2' }] });
    await ctx2.untilTurnEnd();

    expect(findRpcEvent(ctx2.allEvents, 'turn.started')?.args).toMatchObject({ turnId: 3 });
    expect(findRpcEvent(ctx2.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 3,
      reason: 'completed',
    });
  });

  it('projects restored pending tool results before later user messages', async () => {
    const persistence = new RecordingAgentPersistence([
      resumeConfigRecord(),
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run lookup' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'turn.prompt',
        input: [],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'call_lookup',
              name: 'Lookup',
              arguments: JSON.stringify({ query: 'moon' }),
            },
          ],
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Follow-up recorded before result' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'lookup result' }],
          toolCalls: [],
          toolCallId: 'call_lookup',
        },
      },
    ] as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(ctx.context.get().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'tool',
    ]);
    expect(ctx.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(textContent(ctx.project()[2])).toBe('lookup result');
    expect(textContent(ctx.project()[3])).toBe('Follow-up recorded before result');
    expect(persistence.appended).toEqual([]);
    await ctx.expectResumeMatches();
  });

  it('replays inline skill reminders after pending tool results before the next prompt', async () => {
    const persistence = new RecordingAgentPersistence(resumeDeferredSystemReminderHistory() as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(ctx.context.get().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(ctx.context.get()[4]?.content).toEqual([
      {
        type: 'text',
        text: '<system-reminder>\nresume skill body\n</system-reminder>',
      },
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'Fresh response after deferred resume.' });
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Fresh prompt after deferred resume' }],
    });
    await ctx.untilTurnEnd();

    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, Write
        messages:
          user: text "Historical prompt before skill"
          assistant: []  calls call_resume_write:Write { "path": "result.txt" }, call_resume_skill:Skill { "skill": "review" }
          tool[call_resume_write]: text "wrote file"
          tool[call_resume_skill]: text "skill loaded"
          user: text "<system-reminder>\\nresume skill body\\n</system-reminder>"
          user: text "Fresh prompt after deferred resume"
    `);
    await ctx.expectResumeMatches();
  });

  it('applies wire migrations while replaying persisted records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'call_legacy_bash',
              function: {
                name: 'Bash',
                arguments: '{"command":"pwd"}',
              },
            },
          ],
        },
      },
    ] as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    const toolCall = ctx.context.get()[0]?.toolCalls[0] as
      | { name?: string; arguments?: string | null; function?: unknown }
      | undefined;
    expect(toolCall).toMatchObject({
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    });
    expect(toolCall?.function).toBeUndefined();
  });

  it('keeps delivered task notifications indexed after compaction replay', async () => {
    const origin = {
      kind: 'task',
      taskId: 'agent-seen0000',
      status: 'completed',
      notificationId: 'task:agent-seen0000:completed',
    } as const;
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.4',
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'already delivered task notification' }],
          toolCalls: [],
          origin,
        },
      },
      {
        type: 'context.apply_compaction',
        summary: 'Compacted delivered notification.',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 3,
      },
    ] as unknown as WireRecord[]);
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-delivered-'));
    try {
      const backgroundPersistence = createAgentTaskPersistence(homeDir);
      const ctx = testAgent(homeDirServices(homeDir), { autoConfigure: false, persistence });
      await backgroundPersistence.writeTask({
        taskId: 'agent-seen0000',
        kind: 'agent',
        description: 'already delivered',
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_010,
        status: 'completed',
      });
      await backgroundPersistence.appendTaskOutput(
        'agent-seen0000',
        'already delivered summary',
      );
      const steer = vi.spyOn(ctx.get(IAgentPromptService), 'steer');

      await ctx.restorePersisted();
      expect(
        ctx.context.get().some((message) => message.origin?.kind === 'task'),
      ).toBe(false);

      const background = ctx.get(IAgentTaskService) as TaskServiceTestManager;
      await background.loadFromDisk();
      await background.reconcile();

      expect(steer).not.toHaveBeenCalled();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('projects restored compactions into replay records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.4',
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Historical prompt before compaction' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'full_compaction.begin',
        source: 'manual',
        instruction: 'preserve implementation notes',
      },
      {
        type: 'full_compaction.complete',
      },
      {
        type: 'context.apply_compaction',
        summary: 'Compacted implementation notes.',
        compactedCount: 1,
        tokensBefore: 120,
        tokensAfter: 24,
      },
    ] as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(ctx.context.get()).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'Compacted implementation notes.' }],
        origin: { kind: 'compaction_summary' },
      }),
    ]);
  });


  it('persists undelivered restored background notifications during resume', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.4',
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Historical prompt' }],
        origin: { kind: 'user' },
      },
    ] as unknown as WireRecord[]);
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-undelivered-'));
    try {
      const backgroundPersistence = createAgentTaskPersistence(homeDir);
      const ctx = testAgent(homeDirServices(homeDir), { autoConfigure: false, persistence });
      await backgroundPersistence.writeTask({
        taskId: 'agent-new00000',
        kind: 'agent',
        description: 'newly delivered',
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_010,
        status: 'completed',
      });
      await backgroundPersistence.appendTaskOutput('agent-new00000', 'newly delivered summary');
      const steer = vi.spyOn(ctx.get(IAgentPromptService), 'steer');

      await ctx.restorePersisted();

      expect(steer).not.toHaveBeenCalled();
      expect(
        ctx.context.get().some(
          (message) =>
            message.origin?.kind === 'task' &&
            message.origin.taskId === 'agent-new00000',
        ),
      ).toBe(true);
      expect(persistence.appended).toContainEqual(
        expect.objectContaining({
          type: 'context.append_message',
          message: expect.objectContaining({
            origin: {
              kind: 'task',
              taskId: 'agent-new00000',
              status: 'completed',
              notificationId: 'task:agent-new00000:completed',
            },
          }),
        }),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });


  it('drops an orphan tool result whose call was never recorded', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hi' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'turn.prompt',
        input: [],
        origin: { kind: 'user' },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello.' }],
          toolCalls: [],
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'orphaned' }],
          toolCalls: [],
          toolCallId: 'call_ghost',
        },
      },
    ] as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(ctx.context.get().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(ctx.project().map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(ctx.project().some((message) => message.role === 'tool')).toBe(false);
    await ctx.expectResumeMatches();
  });

  it('rebuilds goal completion replay cards without adding model-visible context', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'goal.create',
        goalId: 'goal-1',
        objective: 'ship work',
      },
      {
        type: 'goal.update',
        status: 'complete',
        reason: 'all tests passed',
        turnsUsed: 2,
        tokensUsed: 1200,
        wallClockMs: 65_000,
        actor: 'model',
      },
    ] as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(ctx.context.get()).toHaveLength(0);
  });

  it('restores an envelope-less active interval into a budget-reached paused goal', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(6_000);
    const persistence = new RecordingAgentPersistence(
      [
        {
          type: 'goal.create',
          goalId: 'goal-1',
          objective: 'ship work',
          time: 100,
        },
        {
          type: 'goal.update',
          status: 'paused',
          wallClockMs: 2_000,
          actor: 'user',
          time: 500,
        },
        {
          type: 'goal.update',
          status: 'active',
          budgetLimits: { wallClockBudgetMs: 6_000 },
          actor: 'user',
          time: 1_000,
        },
      ] as unknown as WireRecord[],
      false,
    );
    const ctx = testAgent({ persistence, autoConfigure: false });

    try {
      await ctx.restorePersisted();

      const goal = ctx.get(IAgentGoalService).getGoal().goal;
      expect(goal).toMatchObject({
        status: 'paused',
        wallClockMs: 7_000,
        budget: {
          wallClockBudgetReached: true,
          remainingWallClockMs: 0,
          overBudget: true,
        },
      });
      expect(persistence.appended).toEqual([
        expect.objectContaining({
          type: 'goal.update',
          status: 'paused',
          reason: 'Paused after agent resume',
          wallClockMs: 7_000,
        }),
      ]);
      expect(persistence.rewritten).toContainEqual(
        expect.objectContaining({
          type: 'goal.update',
          status: 'active',
          wallClockResumedAt: 1_000,
        }),
      );
    } finally {
      now.mockRestore();
      await ctx.dispose();
    }
  });

  it('restores only post-checkpoint active time from a 1.3 wall-clock checkpoint', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(6_000);
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.3',
        created_at: 1,
      },
      {
        type: 'goal.create',
        goalId: 'goal-1',
        objective: 'ship work',
        time: 1_000,
      },
      {
        type: 'goal.account_usage',
        goalId: 'goal-1',
        wallClockMs: 3_000,
        time: 4_000,
      },
    ] as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    try {
      await ctx.restorePersisted();

      expect(ctx.get(IAgentGoalService).getGoal().goal).toMatchObject({
        status: 'paused',
        wallClockMs: 5_000,
      });
      expect(persistence.appended).toEqual([
        expect.objectContaining({
          type: 'goal.update',
          status: 'paused',
          wallClockMs: 5_000,
        }),
      ]);
      expect(persistence.rewritten).toContainEqual(
        expect.objectContaining({
          type: 'goal.update',
          wallClockMs: 3_000,
          wallClockResumedAt: 4_000,
        }),
      );
    } finally {
      now.mockRestore();
      await ctx.dispose();
    }
  });

  it('restores context after undo and removes undone messages from replay', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.4',
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'first prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'step-1',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-1',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          part: { type: 'text', text: 'first response' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          uuid: 'step-1',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'second prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'step-2',
          turnId: '1',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'part-2',
          turnId: '1',
          step: 1,
          stepUuid: 'step-2',
          part: { type: 'text', text: 'second response' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.end',
          uuid: 'step-2',
          turnId: '1',
          step: 1,
        },
      },
      { type: 'context.undo', count: 1 },
    ] as unknown as WireRecord[]);
    const ctx = testAgent({ persistence, autoConfigure: false });

    await ctx.restorePersisted();

    expect(ctx.context.get()).toHaveLength(2);
    expect(ctx.context.get()[0]?.role).toBe('user');
    expect(ctx.context.get()[1]?.role).toBe('assistant');
  });
});

class RecordingAgentPersistence extends InMemoryWireRecordPersistence {
  readonly appended: WireRecord[] = [];
  rewritten: readonly WireRecord[] | undefined;

  constructor(events: readonly WireRecord[], addMetadata = true) {
    super(addMetadata ? withMetadata(events) : events);
  }

  override append(input: WireRecord): void {
    this.appended.push(input);
    super.append(input);
  }

  override rewrite(records: readonly WireRecord[]): void {
    this.rewritten = records;
    super.rewrite(records);
  }
}

function withMetadata(events: readonly WireRecord[]): readonly WireRecord[] {
  if (events.length === 0 || events[0]?.type === 'metadata') return events;
  return [
    {
      type: 'metadata',
      protocol_version: WIRE_PROTOCOL_VERSION,
      created_at: 1,
    },
    ...events,
  ];
}

function textContent(
  message:
    | { readonly content: readonly { readonly type: string; readonly text?: string }[] }
    | undefined,
): string {
  return (
    message?.content
      .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('') ?? ''
  );
}

function resumeHistory(): WireRecord[] {
  return [
    {
      type: 'metadata',
      protocol_version: '1.4',
      created_at: 1,
    },
    {
      type: 'config.update',
      cwd: process.cwd(),
      modelAlias: MOCK_PROVIDER.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
    },
    {
      type: 'tools.set_active_tools',
      names: ['Bash'],
    },
    {
      type: 'permission.set_mode',
      mode: 'yolo',
    },
    {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'Historical prompt' }],
      origin: { kind: 'user' },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Historical prompt' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.begin',
        uuid: 'resume-step',
        turnId: '0',
        step: 1,
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: 'resume-content',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-step',
        part: { type: 'text', text: 'Historical assistant text.' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'resume-tool-call',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-step',
        toolCallId: 'call_resume_bash',
        name: 'Bash',
        args: { command: 'printf should-not-rerun', timeout: 60 },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'resume-tool-call',
        toolCallId: 'call_resume_bash',
        result: { output: 'already ran' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: 'resume-step',
        turnId: '0',
        step: 1,
        usage: {
          inputOther: 10,
          output: 2,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        finishReason: 'tool_calls',
      },
    },
    {
      type: 'usage.record',
      model: 'mock-model',
      usage: {
        inputOther: 10,
        output: 2,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    },
    {
      type: 'full_compaction.begin',
      source: 'auto',
    },
    {
      type: 'full_compaction.complete',
    },
    {
      type: 'context.apply_compaction',
      summary: 'Historical compacted summary.',
      compactedCount: 3,
      tokensBefore: 12,
      tokensAfter: 4,
    },
    {
      type: 'plan_mode.enter',
      id: 'resume-plan',
    },
  ] as unknown as WireRecord[];
}

function resumeDeferredSystemReminderHistory(): WireRecord[] {
  return [
    resumeConfigRecord(),
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Historical prompt before skill' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
    {
      type: 'turn.prompt',
      input: [],
      origin: { kind: 'user' },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            type: 'function',
            id: 'call_resume_write',
            name: 'Write',
            arguments: JSON.stringify({ path: 'result.txt' }),
          },
          {
            type: 'function',
            id: 'call_resume_skill',
            name: 'Skill',
            arguments: JSON.stringify({ skill: 'review' }),
          },
        ],
      },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'wrote file' }],
        toolCalls: [],
        toolCallId: 'call_resume_write',
      },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'skill loaded' }],
        toolCalls: [],
        toolCallId: 'call_resume_skill',
      },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>\nresume skill body\n</system-reminder>',
          },
        ],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act_resume_skill',
          skillName: 'review',
          trigger: 'model-tool',
        },
      },
    },
  ] as unknown as WireRecord[];
}

function resumeConfigRecord(): WireRecord {
  return {
    type: 'config.update',
    cwd: process.cwd(),
    modelAlias: MOCK_PROVIDER.model,
    systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
    thinkingLevel: 'off',
  } as unknown as WireRecord;
}

function contextAppendRecord(
  _start: number,
  messages: readonly {
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly origin?: PromptOrigin;
  }[],
): WireRecord {
  const message = messages[0]!;
  return {
    type: 'context.append_message',
    message: {
      role: message.role,
      content: [{ type: 'text', text: message.text }],
      toolCalls: [],
      origin: message.origin,
    },
  } as unknown as WireRecord;
}

function turnPromptRecord(_turnId: number, origin: PromptOrigin): WireRecord {
  return {
    type: 'turn.prompt',
    input: [],
    origin,
  } as unknown as WireRecord;
}

function canonicalPromptedTurn(
  turnId: number,
  promptText: string,
  responseText: string,
  start: number,
): WireRecord[] {
  const origin: PromptOrigin = { kind: 'user' };
  return [
    contextAppendRecord(start, [{ role: 'user', text: promptText, origin }]),
    turnPromptRecord(turnId, origin),
    contextAppendRecord(start + 1, [{ role: 'assistant', text: responseText }]),
  ];
}

function canonicalContinuationTurn(
  turnId: number,
  responseText: string,
  start: number,
): WireRecord[] {
  return [
    turnPromptRecord(turnId, { kind: 'system_trigger', name: 'goal_continuation' }),
    contextAppendRecord(start, [{ role: 'assistant', text: responseText }]),
  ];
}

function loopEventsForTurn(turnId: string, responseText: string): WireRecord[] {
  return [
    {
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: `step-${turnId}`, turnId, step: 1 },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: `content-${turnId}`,
        turnId,
        step: 1,
        stepUuid: `step-${turnId}`,
        part: { type: 'text', text: responseText },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: `step-${turnId}`,
        turnId,
        step: 1,
        usage: { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
      },
    },
    {
      type: 'usage.record',
      model: MOCK_PROVIDER.model,
      usage: { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    },
  ] as unknown as WireRecord[];
}

function multiTurnResumeHistory(): WireRecord[] {
  return [
    resumeConfigRecord(),
    ...canonicalPromptedTurn(0, 'First historical prompt', 'First historical response.', 0),
    ...canonicalPromptedTurn(1, 'Second historical prompt', 'Second historical response.', 2),
  ];
}

function goalContinuationResumeHistory(): WireRecord[] {
  return [
    resumeConfigRecord(),
    ...canonicalPromptedTurn(0, 'Goal prompt', 'Starting the goal.', 0),
    ...canonicalContinuationTurn(1, 'Continuation turn one.', 2),
    ...canonicalContinuationTurn(2, 'Continuation turn two.', 3),
  ];
}


function findRpcEvent(
  ctxEvents: readonly { type: string; event: string; args: unknown }[],
  event: string,
) {
  return ctxEvents.find((entry) => entry.type === '[rpc]' && entry.event === event);
}
