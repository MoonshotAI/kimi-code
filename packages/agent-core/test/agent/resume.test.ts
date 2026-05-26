import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  InMemoryAgentRecordPersistence,
} from '../../src/agent/records';
import { appendTaskOutput, writeTask } from '../../src/tools/background/persist';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { testAgent } from './harness/agent';
import { DEFAULT_TEST_SYSTEM_PROMPT } from './harness/snapshots';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

describe('Agent resume', () => {
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
          assistant: text "Historical compacted summary."
          user: text "Fresh prompt after resume"
          user: text <plan-mode-reminder>
    `);
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
      const ctx = testAgent({ persistence });
      ctx.agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: 'agent-seen0000',
        command: '[agent] already delivered',
        description: 'already delivered',
        pid: 0,
        started_at: 1_700_000_000,
        ended_at: 1_700_000_010,
        exit_code: 0,
        status: 'completed',
      });
      await appendTaskOutput(sessionDir, 'agent-seen0000', 'already delivered summary');
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
      const ctx = testAgent({ persistence });
      ctx.agent.background.attachSessionDir(sessionDir);
      await writeTask(sessionDir, {
        task_id: 'agent-new00000',
        command: '[agent] newly delivered',
        description: 'newly delivered',
        pid: 0,
        started_at: 1_700_000_000,
        ended_at: 1_700_000_010,
        exit_code: 0,
        status: 'completed',
      });
      await appendTaskOutput(sessionDir, 'agent-new00000', 'newly delivered summary');
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

    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual({
      type: 'message',
      message: expect.objectContaining({
        role: 'tool',
        toolCallId: 'call_failed_bash',
        isError: true,
      }),
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

function resumeHistory(): AgentRecord[] {
  return [
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
      summary: 'Historical compacted summary.',
      compactedCount: 3,
      tokensBefore: 12,
      tokensAfter: 4,
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
      thinkingLevel: 'off',
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

function findRpcEvent(
  ctxEvents: readonly { type: string; event: string; args: unknown }[],
  event: string,
) {
  return ctxEvents.find((entry) => entry.type === '[rpc]' && entry.event === event);
}
