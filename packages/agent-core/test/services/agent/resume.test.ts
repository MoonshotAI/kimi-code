import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  BackgroundTaskPersistence,
  InMemoryWireRecordPersistence,
  IPlanModeService,
  IReplayBuilderService,
  ITurnRunner,
  type PersistedWireRecord,
  type PromptOrigin,
} from '../../../src/services/agent';
import type {
  BackgroundTaskInfo,
  IBackgroundService,
} from '../../../src/services/agent/background/background';
import { createFakeKaos } from '../../tools/fixtures/fake-kaos';
import { DEFAULT_TEST_SYSTEM_PROMPT, testAgent } from './harness';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

type BackgroundServiceTestManager = IBackgroundService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly BackgroundTaskInfo[]>;
};

function turnCurrentId(ctx: ReturnType<typeof testAgent>): number {
  const runner = ctx.get(ITurnRunner) as unknown as { nextTurnId: number };
  return runner.nextTurnId - 1;
}

describe('Agent resume', () => {
  it('does not append metadata when resuming records that include legacy app version', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
        app_version: '0.0.1-old',
      } as unknown as PersistedWireRecord,
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'old prompt' }],
        origin: { kind: 'user' },
      } as unknown as PersistedWireRecord,
    ]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(persistence.appended).toEqual([]);
    expect(persistence.records.filter((record) => record.type === 'metadata')).toHaveLength(1);
  });

  it('replays persisted records without restarting turns, compactions, plan turns, or tools', async () => {
    const persistence = new RecordingAgentPersistence(resumeHistory() as unknown as PersistedWireRecord[]);
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute on resume'));
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      persistence,
    });

    await ctx.runtime.restore();

    expect(ctx.get(IPlanModeService).isActive).toBe(true);
    expect(ctx.get(IPlanModeService).planFilePath).toContain('resume-plan');
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
          assistant: text "Historical compacted summary."
          user: text "Fresh prompt after resume"
          user: text <plan-mode-reminder>
    `);
  });

  it('allocates monotonically increasing turnIds across multiple historical turns on resume', async () => {
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory() as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // History ran turnId 0 and 1, so the counter must be restored to 1.
    expect(turnCurrentId(ctx)).toBe(1);

    // After 2 historical turns (turnId 0 and 1), the next fresh turn must be 2.
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
    // A goal drive allocates a fresh turnId per continuation turn even though
    // the internally-driven turns do not have user prompt records.
    const persistence = new RecordingAgentPersistence(goalContinuationResumeHistory() as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // History ran turnId 0 (prompted) plus continuation turns 1 and 2.
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
    // Mirrors a real session that was cold-started several times: each resume
    // must continue the counter, never restart it and collide with history.
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory() as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();
    ctx.mockNextResponse({ type: 'text', text: 'Response in cycle 1.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Prompt in cycle 1' }] });
    await ctx.untilTurnEnd();
    expect(turnCurrentId(ctx)).toBe(2);

    // Cold-start again from everything persisted so far (history + the turn just
    // run). The fresh agent must restore the counter to 2 and allocate 3 next.
    const persistence2 = new RecordingAgentPersistence(persistence.records as unknown as PersistedWireRecord[]);
    const ctx2 = testAgent({ persistence: persistence2 });

    await ctx2.runtime.restore();
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
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Run lookup' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
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
        ],
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Follow-up recorded before result' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'context.splice',
        start: 3,
        deleteCount: 0,
        messages: [
          {
            role: 'tool',
            content: [{ type: 'text', text: 'lookup result' }],
            toolCalls: [],
            toolCallId: 'call_lookup',
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
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
    const persistence = new RecordingAgentPersistence(resumeDeferredSystemReminderHistory() as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(ctx.context.getHistory()[4]?.content).toEqual([
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
        tools: AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, TaskList, TaskOutput, TaskStop, TodoList, Write
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

  it('restores tool store state from persisted records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'Inspect resume snapshot', status: 'done' },
          { title: 'Hydrate TUI todo panel', status: 'in_progress' },
        ],
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.toolStoreData()).toEqual({
      todo: [
        { title: 'Inspect resume snapshot', status: 'done' },
        { title: 'Hydrate TUI todo panel', status: 'in_progress' },
      ],
    });
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
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    const toolCall = ctx.context.getHistory()[0]?.toolCalls[0] as
      | { name?: string; arguments?: string | null; function?: unknown }
      | undefined;
    expect(toolCall).toMatchObject({
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    });
    expect(toolCall?.function).toBeUndefined();
  });

  it('keeps delivered background notifications indexed after compaction replay', async () => {
    const origin = {
      kind: 'background_task',
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
          content: [{ type: 'text', text: 'already delivered background notification' }],
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
    ] as unknown as PersistedWireRecord[]);
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-delivered-'));
    try {
      const backgroundPersistence = new BackgroundTaskPersistence(sessionDir);
      const ctx = testAgent({ persistence, homedir: sessionDir });
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
      const steer = vi.spyOn(ctx.rpcMethods, 'steer');

      await ctx.runtime.restore();
      expect(
        ctx.context.getHistory().some((message) => message.origin?.kind === 'background_task'),
      ).toBe(false);

      const background = ctx.background as BackgroundServiceTestManager;
      await background.loadFromDisk();
      await background.reconcile();

      expect(steer).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
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
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.context.getHistory()).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Compacted implementation notes.' }],
        origin: { kind: 'compaction_summary' },
      }),
    ]);
    expect(ctx.get(IReplayBuilderService).buildResult()).toEqual([
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'user',
          content: [{ type: 'text', text: 'Historical prompt before compaction' }],
        }),
      }),
      expect.objectContaining({
        type: 'compaction',
        result: {
          summary: 'Compacted implementation notes.',
          compactedCount: 1,
          tokensBefore: 120,
          tokensAfter: 24,
        },
        instruction: 'preserve implementation notes',
      }),
    ]);
  });

  it('projects restored cancelled compactions into replay records', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'full_compaction.begin',
        source: 'manual',
        instruction: 'preserve implementation notes',
      },
      {
        type: 'full_compaction.cancel',
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.get(IReplayBuilderService).buildResult()).toEqual([
      expect.objectContaining({
        type: 'compaction',
        result: 'cancelled',
        instruction: 'preserve implementation notes',
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
    ] as unknown as PersistedWireRecord[]);
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-bg-resume-undelivered-'));
    try {
      const backgroundPersistence = new BackgroundTaskPersistence(sessionDir);
      const ctx = testAgent({ persistence, homedir: sessionDir });
      await backgroundPersistence.writeTask({
        taskId: 'agent-new00000',
        kind: 'agent',
        description: 'newly delivered',
        startedAt: 1_700_000_000,
        endedAt: 1_700_000_010,
        status: 'completed',
      });
      await backgroundPersistence.appendTaskOutput('agent-new00000', 'newly delivered summary');
      const steer = vi.spyOn(ctx.rpcMethods, 'steer');

      await ctx.runtime.restore();

      expect(steer).not.toHaveBeenCalled();
      expect(
        ctx.context.getHistory().some(
          (message) =>
            message.origin?.kind === 'background_task' &&
            message.origin.taskId === 'agent-new00000',
        ),
      ).toBe(true);
      // The newly delivered notification is persisted as a v1.5
      // `context.splice` (append) record, not the legacy
      // `context.append_message`.
      expect(persistence.appended).toContainEqual(
        expect.objectContaining({
          type: 'context.splice',
          messages: expect.arrayContaining([
            expect.objectContaining({
              origin: {
                kind: 'background_task',
                taskId: 'agent-new00000',
                status: 'completed',
                notificationId: 'task:agent-new00000:completed',
              },
            }),
          ]),
        }),
      );
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('preserves failed tool result state in replay messages', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: '1.4',
        created_at: 1,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'failed-step',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'failed-call',
          turnId: '0',
          step: 1,
          stepUuid: 'failed-step',
          toolCallId: 'call_failed_bash',
          name: 'Bash',
          args: { command: 'false' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'failed-call',
          toolCallId: 'call_failed_bash',
          result: { output: 'failed', isError: true },
        },
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.get(IReplayBuilderService).buildResult()).toContainEqual(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({
          role: 'tool',
          toolCallId: 'call_failed_bash',
          isError: true,
        }),
      }),
    );
  });

  it('closes interrupted trailing tool calls with synthetic error results after resume', async () => {
    const persistence = new RecordingAgentPersistence([
      resumeConfigRecord(),
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Run both lookups' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [
              {
                type: 'function',
                id: 'call_interrupted_one',
                name: 'LookupOne',
                arguments: JSON.stringify({ query: 'one' }),
              },
              {
                type: 'function',
                id: 'call_interrupted_two',
                name: 'LookupTwo',
                arguments: JSON.stringify({ query: 'two' }),
              },
            ],
          },
        ],
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'tool',
            content: [{ type: 'text', text: 'one result' }],
            toolCalls: [],
            toolCallId: 'call_interrupted_one',
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // Raw history keeps the interrupted call open — closure is not persisted.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    // The projector closes the unanswered call with a synthetic error result.
    const projected = ctx.project();
    expect(projected.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(projected.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted_two',
    });
    expect(textContent(projected.at(-1))).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    // Replay records stay raw (no synthetic result persisted).
    const replayMessages = ctx.get(IReplayBuilderService)
      .buildResult()
      .flatMap((record) => (record.type === 'message' ? [record.message] : []));
    expect(replayMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(persistence.appended).toEqual([]);

    ctx.mockNextResponse({ type: 'text', text: 'Recovered after resume.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after resume' }] });
    await ctx.untilTurnEnd();

    const freshUserRecordIndex = persistence.records.findIndex(
      (record) =>
        isContextSpliceRecord(record) &&
        record.messages.some(
          (message) =>
            message.role === 'user' &&
            textContent(message) === 'continue after resume',
        ),
    );
    expect(freshUserRecordIndex).toBeGreaterThan(-1);

    // The history sent to the model is the projected one — the interrupted call
    // is closed and the new prompt follows.
    const llmHistory = ctx.llmCalls[0]?.history ?? [];
    expect(llmHistory.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(textContent(llmHistory[3])).toContain(
      '<system>ERROR: Tool execution failed.</system>',
    );
    expect(textContent(llmHistory[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(textContent(llmHistory[4])).toBe('continue after resume');
    expect(
      ctx.context.getHistory().some(
        (message) => message.role === 'user' && textContent(message) === 'continue after resume',
      ),
    ).toBe(true);

    const resumedAgain = testAgent({ persistence });
    await resumedAgain.runtime.restore();

    // Restored again: the open call is still raw (unclosed) in history; the
    // projector re-synthesizes its result on demand.
    expect(resumedAgain.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    expect(resumedAgain.project().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
    ]);
    expect(textContent(resumedAgain.project()[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(textContent(resumedAgain.context.getHistory()[3])).toBe('continue after resume');
  });

  it('closes an interrupted tool call mid-history so later turns stay aligned', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Run the lookup' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [
              {
                type: 'function',
                id: 'call_interrupted',
                name: 'Lookup',
                arguments: JSON.stringify({ query: 'one' }),
              },
            ],
          },
        ],
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'keep going' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 1,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 3,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'All done.' }],
            toolCalls: [],
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // Raw history keeps the interrupted mid-history call open (no synthetic
    // result persisted); the deferred prompt stays in its recorded position.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(textContent(ctx.context.getHistory()[2])).toBe('keep going');
    expect(textContent(ctx.context.getHistory()[3])).toBe('All done.');

    // The projector closes the interrupted call in place (index 2), directly
    // after the interrupted assistant step — not flushed to the tail.
    const projected = ctx.project();
    expect(projected.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    expect(projected[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted',
    });
    expect(textContent(projected[2])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(textContent(projected[3])).toBe('keep going');
    expect(textContent(projected[4])).toBe('All done.');

    // The mid-history result is re-derived on every projection and is never
    // persisted as a positioned record.
    expect(
      persistence.appended.filter(
        (record) =>
          isLegacyAppendLoopEventRecord(record) && record.event.type === 'tool.result',
      ),
    ).toEqual([]);

    await ctx.expectResumeMatches();
  });

  it('drops a stale tail interrupted result already closed in place on resume', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Run the lookup' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [
              {
                type: 'function',
                id: 'call_interrupted',
                name: 'Lookup',
                arguments: JSON.stringify({ query: 'one' }),
              },
            ],
          },
        ],
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'keep going' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 1,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 3,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'All done.' }],
            toolCalls: [],
          },
        ],
      },
      {
        type: 'context.splice',
        start: 4,
        deleteCount: 0,
        messages: [
          {
            role: 'tool',
            content: [
              {
                type: 'text',
                text:
                  '<system>ERROR: Tool execution failed.</system>\n' +
                  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.',
              },
            ],
            toolCalls: [],
            toolCallId: 'call_interrupted',
            isError: true,
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // Raw history keeps the stale tail result exactly as recorded.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
    ]);
    // The projector closes the call in place (index 2) and drops the stale tail
    // duplicate, leaving exactly one (synthetic) result.
    const projected = ctx.project();
    expect(projected.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    expect(projected[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted',
    });
    expect(textContent(projected[2])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(textContent(projected[4])).toBe('All done.');
    await ctx.expectResumeMatches();
  });

  it('closes every open call of a multi-call interrupted step in order', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Run both' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: ['call_a', 'call_b'].map((toolCallId) => ({
              type: 'function',
              id: toolCallId,
              name: 'Lookup',
              arguments: JSON.stringify({}),
            })),
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 1,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'All done.' }],
            toolCalls: [],
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // Raw history keeps the interrupted multi-call step open.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ]);
    // The projector closes both open calls, in tool-call order, before the next
    // turn.
    const projected = ctx.project();
    expect(projected.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(projected[2]).toMatchObject({ role: 'tool', toolCallId: 'call_a' });
    expect(projected[3]).toMatchObject({ role: 'tool', toolCallId: 'call_b' });
    await ctx.expectResumeMatches();
  });

  it('synthesizes only the unresolved call when a step is partially resolved', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Run both' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: ['call_done', 'call_open'].map((toolCallId) => ({
              type: 'function',
              id: toolCallId,
              name: 'Lookup',
              arguments: JSON.stringify({}),
            })),
          },
        ],
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'tool',
            content: [{ type: 'text', text: 'real result' }],
            toolCalls: [],
            toolCallId: 'call_done',
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 1,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 3,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'All done.' }],
            toolCalls: [],
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // Raw history keeps the recorded result and leaves the second call open.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(ctx.context.getHistory()[2]).toMatchObject({ toolCallId: 'call_done' });
    expect(textContent(ctx.context.getHistory()[2])).toBe('real result');
    // The projector keeps the recorded result verbatim and synthesizes only the
    // open call.
    const projected = ctx.project();
    expect(projected.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(projected[2]).toMatchObject({ toolCallId: 'call_done' });
    expect(textContent(projected[2])).toBe('real result');
    expect(projected[3]).toMatchObject({ toolCallId: 'call_open' });
    expect(textContent(projected[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    await ctx.expectResumeMatches();
  });

  it('closes consecutive interrupted steps each at their own boundary', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Go' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [
              {
                type: 'function',
                id: 'call_one',
                name: 'Lookup',
                arguments: JSON.stringify({}),
              },
            ],
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 1,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [
              {
                type: 'function',
                id: 'call_two',
                name: 'Lookup',
                arguments: JSON.stringify({}),
              },
            ],
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 2,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 3,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }],
            toolCalls: [],
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // Raw history keeps both interrupted steps open.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
    ]);
    // The projector closes each interrupted step at its own boundary.
    const projected = ctx.project();
    expect(projected.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(projected[2]).toMatchObject({ toolCallId: 'call_one' });
    expect(projected[4]).toMatchObject({ toolCallId: 'call_two' });
    await ctx.expectResumeMatches();
  });

  it('drops an orphan tool result whose call was never recorded', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Hi' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        ],
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
      {
        type: 'context.splice',
        start: 1,
        deleteCount: 0,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello.' }],
            toolCalls: [],
          },
        ],
      },
      {
        type: 'context.splice',
        start: 2,
        deleteCount: 0,
        messages: [
          {
            role: 'tool',
            content: [{ type: 'text', text: 'orphaned' }],
            toolCalls: [],
            toolCallId: 'call_ghost',
          },
        ],
      },
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    // Raw history keeps the orphan result as recorded.
    expect(ctx.context.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    // The projector drops the orphan (its call was never recorded).
    expect(ctx.project().map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(ctx.project().some((message) => message.role === 'tool')).toBe(false);
    await ctx.expectResumeMatches();
  });

  it('rebuilds goal completion replay cards without adding model-visible context', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
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
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.context.getHistory()).toHaveLength(0);
    expect(ctx.get(IReplayBuilderService).buildResult()).toContainEqual(
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({
          status: 'complete',
          terminalReason: 'all tests passed',
          turnsUsed: 2,
          tokensUsed: 1200,
          wallClockMs: 65_000,
        }),
        change: {
          kind: 'completion',
          status: 'complete',
          reason: 'all tests passed',
          stats: { turnsUsed: 2, tokensUsed: 1200, wallClockMs: 65_000 },
          actor: 'model',
        },
      }),
    );
  });

  it('removes replay messages matching undone history', async () => {
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
    ] as unknown as PersistedWireRecord[]);
    const ctx = testAgent({ persistence });

    await ctx.runtime.restore();

    expect(ctx.context.getHistory()).toHaveLength(2);
    expect(ctx.context.getHistory()[0]?.role).toBe('user');
    expect(ctx.context.getHistory()[1]?.role).toBe('assistant');

    const replay = ctx.get(IReplayBuilderService).buildResult();
    expect(replay).toHaveLength(2);
    expect(replay[0]).toMatchObject({
      type: 'message',
      message: expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'first prompt' }] }),
    });
    expect(replay[1]).toMatchObject({
      type: 'message',
      message: expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'first response' }] }),
    });
  });
});

class RecordingAgentPersistence extends InMemoryWireRecordPersistence {
  readonly appended: PersistedWireRecord[] = [];
  rewritten: readonly PersistedWireRecord[] | undefined;

  constructor(events: readonly PersistedWireRecord[]) {
    super(withMetadata(events));
  }

  override append(input: PersistedWireRecord): void {
    this.appended.push(input);
    super.append(input);
  }

  override rewrite(records: readonly PersistedWireRecord[]): void {
    this.rewritten = records;
    super.rewrite(records);
  }
}

function withMetadata(events: readonly PersistedWireRecord[]): readonly PersistedWireRecord[] {
  if (events.length === 0 || events[0]?.type === 'metadata') return events;
  return [
    {
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
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

type ContextSpliceRecord = PersistedWireRecord & {
  readonly type: 'context.splice';
  readonly messages: readonly {
    readonly role: string;
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  }[];
};

function isContextSpliceRecord(record: PersistedWireRecord): record is ContextSpliceRecord {
  return record.type === 'context.splice';
}

function isLegacyAppendLoopEventRecord(
  record: PersistedWireRecord,
): record is PersistedWireRecord & {
  readonly type: 'context.append_loop_event';
  readonly event: { readonly type: string; readonly toolCallId?: string };
} {
  return record.type === 'context.append_loop_event' && isRecord(record['event']);
}

function isLegacyAppendMessageRecord(
  record: PersistedWireRecord,
): record is PersistedWireRecord & {
  readonly type: 'context.append_message';
  readonly message: {
    readonly role: string;
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  };
} {
  return record.type === 'context.append_message' && isRecord(record['message']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resumeHistory(): PersistedWireRecord[] {
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
        finishReason: 'tool_use',
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
  ] as unknown as PersistedWireRecord[];
}

function resumeDeferredSystemReminderHistory(): PersistedWireRecord[] {
  return [
    resumeConfigRecord(),
    {
      type: 'context.splice',
      start: 0,
      deleteCount: 0,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Historical prompt before skill' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      ],
    },
    {
      type: 'turn.launch',
      turnId: 0,
      origin: { kind: 'user' },
    },
    {
      type: 'context.splice',
      start: 1,
      deleteCount: 0,
      messages: [
        {
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
      ],
    },
    {
      type: 'context.splice',
      start: 2,
      deleteCount: 0,
      messages: [
        {
          role: 'tool',
          content: [{ type: 'text', text: 'wrote file' }],
          toolCalls: [],
          toolCallId: 'call_resume_write',
        },
      ],
    },
    {
      type: 'context.splice',
      start: 3,
      deleteCount: 0,
      messages: [
        {
          role: 'tool',
          content: [{ type: 'text', text: 'skill loaded' }],
          toolCalls: [],
          toolCallId: 'call_resume_skill',
        },
      ],
    },
    {
      type: 'context.splice',
      start: 4,
      deleteCount: 0,
      messages: [
        {
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
      ],
    },
  ] as unknown as PersistedWireRecord[];
}

function resumeConfigRecord(): PersistedWireRecord {
  return {
    type: 'config.update',
    cwd: process.cwd(),
    modelAlias: MOCK_PROVIDER.model,
    systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
    thinkingLevel: 'off',
  } as unknown as PersistedWireRecord;
}

function contextSpliceRecord(
  start: number,
  messages: readonly {
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly origin?: PromptOrigin;
  }[],
): PersistedWireRecord {
  return {
    type: 'context.splice',
    start,
    deleteCount: 0,
    messages: messages.map((message) => ({
      role: message.role,
      content: [{ type: 'text', text: message.text }],
      toolCalls: [],
      origin: message.origin,
    })),
  } as unknown as PersistedWireRecord;
}

function turnLaunchRecord(turnId: number, origin: PromptOrigin): PersistedWireRecord {
  return {
    type: 'turn.launch',
    turnId,
    origin,
  } as unknown as PersistedWireRecord;
}

function canonicalPromptedTurn(
  turnId: number,
  promptText: string,
  responseText: string,
  start: number,
): PersistedWireRecord[] {
  const origin: PromptOrigin = { kind: 'user' };
  return [
    contextSpliceRecord(start, [{ role: 'user', text: promptText, origin }]),
    turnLaunchRecord(turnId, origin),
    contextSpliceRecord(start + 1, [{ role: 'assistant', text: responseText }]),
  ];
}

function canonicalContinuationTurn(
  turnId: number,
  responseText: string,
  start: number,
): PersistedWireRecord[] {
  return [
    turnLaunchRecord(turnId, { kind: 'system_trigger', name: 'goal_continuation' }),
    contextSpliceRecord(start, [{ role: 'assistant', text: responseText }]),
  ];
}

// Loop events for one fully-run turn: a single step that emits text and ends.
// Used to represent both prompted turns and internal (goal-continuation) turns.
function loopEventsForTurn(turnId: string, responseText: string): PersistedWireRecord[] {
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
        finishReason: 'end_turn',
      },
    },
    {
      type: 'usage.record',
      model: MOCK_PROVIDER.model,
      usage: { inputOther: 5, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    },
  ] as unknown as PersistedWireRecord[];
}

function multiTurnResumeHistory(): PersistedWireRecord[] {
  return [
    resumeConfigRecord(),
    ...canonicalPromptedTurn(0, 'First historical prompt', 'First historical response.', 0),
    ...canonicalPromptedTurn(1, 'Second historical prompt', 'Second historical response.', 2),
  ];
}

// One prompted turn (turnId 0) followed by two internally-driven turns (1, 2).
function goalContinuationResumeHistory(): PersistedWireRecord[] {
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
