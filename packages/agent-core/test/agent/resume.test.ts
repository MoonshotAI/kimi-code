import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
} from '../../src/agent/records';
import { BackgroundTaskPersistence } from '../../src/agent/background';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { testAgent } from './harness/agent';
import { DEFAULT_TEST_SYSTEM_PROMPT } from './harness/snapshots';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

describe('Agent resume', () => {
  it('does not append metadata when resuming records that include legacy app version', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
        app_version: '0.0.1-old',
      } as unknown as AgentRecord,
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'old prompt' }],
        origin: { kind: 'user' },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(persistence.appended).toEqual([]);
    expect(persistence.records.filter((record) => record.type === 'metadata')).toHaveLength(1);
  });

  it('replays persisted records without restarting turns, compactions, plan turns, or tools', async () => {
    const persistence = new RecordingAgentPersistence(resumeHistory());
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute on resume'));
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
      persistence,
    });

    await ctx.agent.resume();

    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.agent.planMode.planFilePath).toContain('resume-plan');
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
          user: text "Historical prompt"
          user: text "Historical compacted summary."
          user: text "Fresh prompt after resume"
          user: text <plan-mode-reminder>
    `);
  });

  it('allocates monotonically increasing turnIds across multiple historical turns on resume', async () => {
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // History ran turnId 0 and 1, so the counter must be restored to 1.
    expect(ctx.agent.turn.currentId).toBe(1);

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
    // A goal drive allocates a fresh turnId per continuation turn but only the
    // first turn has a `turn.prompt` record — the continuations are driven
    // internally. The persisted loop events still carry the real turnId, so the
    // counter must be restored from them, not from the prompt records alone.
    const persistence = new RecordingAgentPersistence(goalContinuationResumeHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // History ran turnId 0 (prompted) plus continuation turns 1 and 2.
    expect(ctx.agent.turn.currentId).toBe(2);

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
    const persistence = new RecordingAgentPersistence(multiTurnResumeHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();
    ctx.mockNextResponse({ type: 'text', text: 'Response in cycle 1.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Prompt in cycle 1' }] });
    await ctx.untilTurnEnd();
    expect(ctx.agent.turn.currentId).toBe(2);

    // Cold-start again from everything persisted so far (history + the turn just
    // run). The fresh agent must restore the counter to 2 and allocate 3 next.
    const persistence2 = new RecordingAgentPersistence(persistence.records);
    const ctx2 = testAgent({ persistence: persistence2 });

    await ctx2.agent.resume();
    expect(ctx2.agent.turn.currentId).toBe(2);

    ctx2.mockNextResponse({ type: 'text', text: 'Response in cycle 2.' });
    await ctx2.rpc.prompt({ input: [{ type: 'text', text: 'Prompt in cycle 2' }] });
    await ctx2.untilTurnEnd();

    expect(findRpcEvent(ctx2.allEvents, 'turn.started')?.args).toMatchObject({ turnId: 3 });
    expect(findRpcEvent(ctx2.allEvents, 'turn.ended')?.args).toMatchObject({
      turnId: 3,
      reason: 'completed',
    });
  });

  it('replays inline skill reminders after pending tool results before the next prompt', async () => {
    const persistence = new RecordingAgentPersistence(resumeDeferredSystemReminderHistory());
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    expect(ctx.agent.context.messages[4]?.content).toEqual([
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
        tools: []
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
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'Inspect resume snapshot', status: 'done' },
          { title: 'Hydrate TUI todo panel', status: 'in_progress' },
        ],
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.tools.storeData()).toEqual({
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
      } as unknown as AgentRecord,
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    const toolCall = ctx.agent.context.messages[0]?.toolCalls[0] as
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
    ]);
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
      const steer = vi.spyOn(ctx.agent.turn, 'steer');

      await ctx.agent.resume();
      expect(
        ctx.agent.context.history.some((message) => message.origin?.kind === 'background_task'),
      ).toBe(false);

      await ctx.agent.background.loadFromDisk();
      await ctx.agent.background.reconcile();

      expect(steer).not.toHaveBeenCalled();
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('projects restored compactions into replay records', async () => {
    const persistence = new RecordingAgentPersistence([
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
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'Historical prompt before compaction' }],
      }),
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'Compacted implementation notes.' }],
        origin: { kind: 'compaction_summary' },
      }),
    ]);
    expect(ctx.agent.replayBuilder.buildResult()).toEqual([
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
          contextSummary: 'Compacted implementation notes.',
          compactedCount: 1,
          tokensBefore: 120,
          tokensAfter: 24,
          keptUserMessageCount: 1,
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
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.replayBuilder.buildResult()).toEqual([
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
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Historical prompt' }],
        origin: { kind: 'user' },
      },
    ]);
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
      const steer = vi.spyOn(ctx.agent.turn, 'steer');

      await ctx.agent.resume();

      expect(steer).not.toHaveBeenCalled();
      expect(
        ctx.agent.context.history.some(
          (message) =>
            message.origin?.kind === 'background_task' &&
            message.origin.taskId === 'agent-new00000',
        ),
      ).toBe(true);
      expect(persistence.appended).toContainEqual(
        expect.objectContaining({
          type: 'context.append_message',
          message: expect.objectContaining({
            origin: {
              kind: 'background_task',
              taskId: 'agent-new00000',
              status: 'completed',
              notificationId: 'task:agent-new00000:completed',
            },
          }),
        }),
      );
    } finally {
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('preserves failed tool result state in replay messages', async () => {
    const persistence = new RecordingAgentPersistence([
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
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual(
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
      {
        type: 'config.update',
        cwd: process.cwd(),
        modelAlias: MOCK_PROVIDER.model,
        systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
        thinkingEffort: 'off',
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run both lookups' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'step.begin',
          uuid: 'interrupted-step',
          turnId: '0',
          step: 1,
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-one',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted_one',
          name: 'LookupOne',
          args: { query: 'one' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-two',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted_two',
          name: 'LookupTwo',
          args: { query: 'two' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call-one',
          toolCallId: 'call_interrupted_one',
          result: { output: 'one result' },
        },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    const syntheticResult = ctx.agent.context.history.at(-1);
    expect(syntheticResult).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted_two',
      isError: true,
    });
    expect(textContent(syntheticResult)).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    const replayMessages = ctx.agent.replayBuilder
      .buildResult()
      .flatMap((record) => (record.type === 'message' ? [record.message] : []));
    expect(replayMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(replayMessages.at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted_two',
      isError: true,
    });
    expect(textContent(replayMessages.at(-1))).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(
      persistence.appended.filter(
        (record) =>
          record.type === 'context.append_loop_event' &&
          record.event.type === 'tool.result' &&
          record.event.toolCallId === 'call_interrupted_two',
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'context.append_loop_event',
        event: expect.objectContaining({
          type: 'tool.result',
          parentUuid: 'call_interrupted_two',
          toolCallId: 'call_interrupted_two',
          result: {
            output:
              'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.',
            isError: true,
          },
        }),
      }),
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'Recovered after resume.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after resume' }] });
    await ctx.untilTurnEnd();

    const syntheticRecordIndex = persistence.records.findIndex(
      (record) =>
        record.type === 'context.append_loop_event' &&
        record.event.type === 'tool.result' &&
        record.event.toolCallId === 'call_interrupted_two',
    );
    const freshUserRecordIndex = persistence.records.findIndex(
      (record) =>
        record.type === 'context.append_message' &&
        record.message.role === 'user' &&
        textContent(record.message) === 'continue after resume',
    );
    expect(syntheticRecordIndex).toBeGreaterThan(-1);
    expect(freshUserRecordIndex).toBeGreaterThan(-1);
    expect(syntheticRecordIndex).toBeLessThan(freshUserRecordIndex);

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
      ctx.agent.context.history.some(
        (message) => message.role === 'user' && textContent(message) === 'continue after resume',
      ),
    ).toBe(true);

    const resumedAgain = testAgent({ persistence });
    await resumedAgain.agent.resume();

    expect(resumedAgain.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
    ]);
    expect(textContent(resumedAgain.agent.context.history[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    expect(textContent(resumedAgain.agent.context.history[4])).toBe('continue after resume');
  });

  it('closes an interrupted tool call mid-history so later turns stay aligned', async () => {
    // An interrupted tool call (`call_interrupted`) sits in the MIDDLE of the
    // recorded stream: a later user prompt and a fully-run assistant turn follow
    // it. Without in-place reconciliation the unresolved exchange keeps
    // `hasOpenToolExchange` true, stranding the later user prompt in
    // `deferredMessages` and only aligning the trailing turn.
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run the lookup' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-interrupted',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted',
          name: 'Lookup',
          args: { query: 'one' },
        },
      },
      // Recorded while the interrupted exchange was still open, so live deferral
      // captured it after the unresolved tool call.
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'keep going' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      ...loopEventsForTurn('1', 'All done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    // The synthetic result is spliced in place (index 2), directly after the
    // interrupted assistant step — not flushed to the tail.
    const synthetic = ctx.agent.context.history[2];
    expect(synthetic).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted',
      isError: true,
    });
    expect(textContent(synthetic)).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    // The deferred user prompt is restored in its recorded position, between the
    // closed exchange and the following turn.
    expect(textContent(ctx.agent.context.history[3])).toBe('keep going');
    expect(textContent(ctx.agent.context.history[4])).toBe('All done.');

    expect(ctx.agent.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);

    // Option A: the mid-history result is re-derived on every resume and is not
    // persisted as a positioned record (replay logging is suppressed).
    expect(
      persistence.appended.filter(
        (record) =>
          record.type === 'context.append_loop_event' && record.event.type === 'tool.result',
      ),
    ).toEqual([]);

    await ctx.expectResumeMatches();
  });

  it('drops a stale tail interrupted result already closed in place on resume', async () => {
    // Legacy log: an older tail-only finishResume appended the synthetic result
    // for `call_interrupted` at the END of the stream (after the later turn from
    // the deferral avalanche). The new in-place closure handles it at step.begin,
    // so the trailing persisted copy must be dropped rather than duplicated.
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run the lookup' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call-interrupted',
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId: 'call_interrupted',
          name: 'Lookup',
          args: { query: 'one' },
        },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'keep going' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      ...loopEventsForTurn('1', 'All done.'),
      // The stale synthetic result an older resume appended at the tail.
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call_interrupted',
          toolCallId: 'call_interrupted',
          result: {
            output:
              'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.',
            isError: true,
          },
        },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // The trailing duplicate is dropped: exactly one synthetic result, in place.
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    expect(ctx.agent.context.history[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_interrupted',
      isError: true,
    });
    expect(textContent(ctx.agent.context.history[4])).toBe('All done.');
    await ctx.expectResumeMatches();
  });

  it('closes every open call of a multi-call interrupted step in order', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run both' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      ...['call_a', 'call_b'].map((toolCallId) => ({
        type: 'context.append_loop_event' as const,
        event: {
          type: 'tool.call' as const,
          uuid: toolCallId,
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId,
          name: 'Lookup',
          args: {},
        },
      })),
      ...loopEventsForTurn('1', 'All done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    // Both open calls get a synthetic result, in tool-call order, before the
    // next turn.
    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(ctx.agent.context.history[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_a',
      isError: true,
    });
    expect(ctx.agent.context.history[3]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_b',
      isError: true,
    });
    await ctx.expectResumeMatches();
  });

  it('synthesizes only the unresolved call when a step is partially resolved', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Run both' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step', turnId: '0', step: 1 },
      },
      ...['call_done', 'call_open'].map((toolCallId) => ({
        type: 'context.append_loop_event' as const,
        event: {
          type: 'tool.call' as const,
          uuid: toolCallId,
          turnId: '0',
          step: 1,
          stepUuid: 'interrupted-step',
          toolCallId,
          name: 'Lookup',
          args: {},
        },
      })),
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'call_done',
          toolCallId: 'call_done',
          result: { output: 'real result' },
        },
      },
      ...loopEventsForTurn('1', 'All done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    // The recorded result is kept verbatim; only the open call is synthesized.
    expect(ctx.agent.context.history[2]).toMatchObject({ toolCallId: 'call_done' });
    expect(textContent(ctx.agent.context.history[2])).toBe('real result');
    expect(ctx.agent.context.history[3]).toMatchObject({
      toolCallId: 'call_open',
      isError: true,
    });
    expect(textContent(ctx.agent.context.history[3])).toContain(
      'Tool execution was interrupted before its result was recorded',
    );
    await ctx.expectResumeMatches();
  });

  it('closes consecutive interrupted steps each at their own boundary', async () => {
    const persistence = new RecordingAgentPersistence([
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Go' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      // First interrupted step.
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call_one',
          turnId: '0',
          step: 1,
          stepUuid: 'step-1',
          toolCallId: 'call_one',
          name: 'Lookup',
          args: {},
        },
      },
      // Second interrupted step (closes the first in place at its step.begin).
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'step-2', turnId: '1', step: 1 },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'call_two',
          turnId: '1',
          step: 1,
          stepUuid: 'step-2',
          toolCallId: 'call_two',
          name: 'Lookup',
          args: {},
        },
      },
      // Final fully-run turn (closes the second in place).
      ...loopEventsForTurn('2', 'Done.'),
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(ctx.agent.context.history[2]).toMatchObject({ toolCallId: 'call_one', isError: true });
    expect(ctx.agent.context.history[4]).toMatchObject({ toolCallId: 'call_two', isError: true });
    await ctx.expectResumeMatches();
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
      ...loopEventsForTurn('0', 'Hello.'),
      // A result with no matching tool.call (e.g. its call was compacted away).
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'ghost',
          toolCallId: 'call_ghost',
          result: { output: 'orphaned' },
        },
      },
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(
      ctx.agent.context.history.some((message) => message.role === 'tool'),
    ).toBe(false);
    await ctx.expectResumeMatches();
  });

  it('rebuilds goal completion replay cards without adding model-visible context', async () => {
    const persistence = new RecordingAgentPersistence([
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
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history).toHaveLength(0);
    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual(
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
    ]);
    const ctx = testAgent({ persistence });

    await ctx.agent.resume();

    expect(ctx.agent.context.history).toHaveLength(2);
    expect(ctx.agent.context.history[0]?.role).toBe('user');
    expect(ctx.agent.context.history[1]?.role).toBe('assistant');

    const replay = ctx.agent.replayBuilder.buildResult();
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

class RecordingAgentPersistence extends InMemoryAgentRecordPersistence {
  readonly appended: AgentRecord[] = [];
  rewritten: readonly AgentRecord[] | undefined;

  constructor(events: readonly AgentRecord[]) {
    super(withMetadata(events));
  }

  override append(input: AgentRecord): void {
    this.appended.push(input);
    super.append(input);
  }

  override rewrite(records: readonly AgentRecord[]): void {
    this.rewritten = records;
    super.rewrite(records);
  }
}

function withMetadata(events: readonly AgentRecord[]): readonly AgentRecord[] {
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

function resumeHistory(): AgentRecord[] {
  return [
    {
      type: 'config.update',
      cwd: process.cwd(),
      modelAlias: MOCK_PROVIDER.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingEffort: 'off',
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
  ];
}

function resumeDeferredSystemReminderHistory(): AgentRecord[] {
  return [
    {
      type: 'config.update',
      cwd: process.cwd(),
      modelAlias: MOCK_PROVIDER.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingEffort: 'off',
    },
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
      type: 'context.append_loop_event',
      event: {
        type: 'step.begin',
        uuid: 'resume-skill-step',
        turnId: '0',
        step: 1,
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call_resume_write',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-skill-step',
        toolCallId: 'call_resume_write',
        name: 'Write',
        args: { path: 'result.txt' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'call_resume_skill',
        turnId: '0',
        step: 1,
        stepUuid: 'resume-skill-step',
        toolCallId: 'call_resume_skill',
        name: 'Skill',
        args: { skill: 'review' },
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
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_resume_write',
        toolCallId: 'call_resume_write',
        result: { output: 'wrote file' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        parentUuid: 'call_resume_skill',
        toolCallId: 'call_resume_skill',
        result: { output: 'skill loaded' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'step.end',
        uuid: 'resume-skill-step',
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
  ];
}

function resumeConfigRecord(): AgentRecord {
  return {
    type: 'config.update',
    cwd: process.cwd(),
    modelAlias: MOCK_PROVIDER.model,
    systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
    thinkingEffort: 'off',
  };
}

// Loop events for one fully-run turn: a single step that emits text and ends.
// Used to represent both prompted turns and internal (goal-continuation) turns.
function loopEventsForTurn(turnId: string, responseText: string): AgentRecord[] {
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
  ];
}

// A prompted turn: the `turn.prompt` record + the appended user message + the
// loop events the turn produced.
function minimalPromptedTurn(turnId: string, promptText: string, responseText: string): AgentRecord[] {
  return [
    {
      type: 'turn.prompt',
      input: [{ type: 'text', text: promptText }],
      origin: { kind: 'user' },
    },
    {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    },
    ...loopEventsForTurn(turnId, responseText),
  ];
}

function multiTurnResumeHistory(): AgentRecord[] {
  return [
    resumeConfigRecord(),
    ...minimalPromptedTurn('0', 'First historical prompt', 'First historical response.'),
    ...minimalPromptedTurn('1', 'Second historical prompt', 'Second historical response.'),
  ];
}

// One prompted turn (turnId 0) followed by two goal-continuation turns (1, 2)
// that have NO turn.prompt record — only loop events carry their turnId.
function goalContinuationResumeHistory(): AgentRecord[] {
  return [
    resumeConfigRecord(),
    ...minimalPromptedTurn('0', 'Goal prompt', 'Starting the goal.'),
    ...loopEventsForTurn('1', 'Continuation turn one.'),
    ...loopEventsForTurn('2', 'Continuation turn two.'),
  ];
}


function findRpcEvent(
  ctxEvents: readonly { type: string; event: string; args: unknown }[],
  event: string,
) {
  return ctxEvents.find((entry) => entry.type === '[rpc]' && entry.event === event);
}
