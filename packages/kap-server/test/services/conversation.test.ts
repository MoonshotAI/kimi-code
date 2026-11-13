import {
  IAgentBlobService,
  IAgentLoopService,
  IEventBus,
  IEventDispatcher,
  ILogService,
  InteractionRequestEvent,
  InteractionResolvedEvent,
  makeAgentScopeContext,
  type IAgentScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import type { CollectionView } from '@moonshot-ai/agent-core-v2/_base/di/collection';
import { ContextAppendLoopEvent, ContextAppendMessage, ContextClear } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { AssistantDelta, ThinkingDelta, ToolCallDelta } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { TaskStarted } from '@moonshot-ai/agent-core-v2/agent/task/taskOps';
import type { AgentTaskInfo } from '@moonshot-ai/agent-core-v2/agent/task/types';
import { AgentStateService } from '@moonshot-ai/agent-core-v2/agent/state/agentStateService';
import { ToolUpdated } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import { EventBusService } from '@moonshot-ai/agent-core-v2/app/event/eventBusService';
import type { ContentPart } from '@moonshot-ai/core/llm/message';
import { EventDispatcherService } from '@moonshot-ai/agent-core-v2/state/eventDispatcherService';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';
import type { IWireService } from '@moonshot-ai/agent-core-v2/wire/wire';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationItem, ConversationTurn } from '../../src/protocol/conversation';
import {
  applyConversationRecord,
  createConversationState,
  settleOrphanTurns,
  undoConversationTurns,
  type ConversationFork,
  type ConversationState,
} from '../../src/services/conversation/conversationFold';
import { ConversationFeed, type ConversationEvent } from '../../src/services/conversation/conversationFeed';

let clock = 1_000;

function record(type: string, payload: Record<string, unknown>): WireRecord {
  return { type, agentId: 'main', ...payload, time: clock++ };
}

const turnPrompt = (turnId: number | undefined, promptId: string | undefined, origin?: Record<string, unknown>): WireRecord =>
  record('turn.prompt', { turnId, promptId, origin: origin ?? { kind: 'user' }, input: [] });

const message = (
  role: 'user' | 'assistant' | 'tool',
  content: string,
  extra: Record<string, unknown> = {},
): WireRecord =>
  record('context.append_message', {
    message: { role, content: [{ type: 'text', text: content }], toolCalls: [], ...extra },
  });

const userMessage = (id: string | undefined, text: string, origin?: Record<string, unknown>): WireRecord =>
  message('user', text, { id, origin: origin ?? { kind: 'user' } });

const loop = (event: Record<string, unknown>): WireRecord => record('context.append_loop_event', { event });

const stepBegin = (turnId: number, step: number, uuid: string): WireRecord =>
  loop({ type: 'step.begin', uuid, turnId: String(turnId), step });

const stepEnd = (turnId: number, step: number, uuid: string, extra: Record<string, unknown> = {}): WireRecord =>
  loop({ type: 'step.end', uuid, turnId: String(turnId), step, ...extra });

const contentPart = (
  turnId: number,
  step: number,
  stepUuid: string,
  part: Record<string, unknown>,
  block?: number,
  timing: { startedAt?: number; durationMs?: number } = {},
): WireRecord => loop({ type: 'content.part', turnId: String(turnId), step, stepUuid, part, block, ...timing });

const toolCall = (turnId: number, step: number, stepUuid: string, toolCallId: string, name: string, args?: unknown): WireRecord =>
  loop({ type: 'tool.call', turnId: String(turnId), step, stepUuid, toolCallId, name, args });

const toolResult = (toolCallId: string, output: unknown, isError?: boolean): WireRecord =>
  loop({ type: 'tool.result', toolCallId, result: { output, isError, durationMs: 5 } });

const turnEnded = (turnId: number, reason: string, extra: Record<string, unknown> = {}): WireRecord =>
  record('turn.ended', { turnId, reason, ...extra });

const notificationXml = (taskId: string, extra = ''): string =>
  `<notification id="task:${taskId}:completed" category="task" type="task.completed" source_kind="background_task" source_id="${taskId}">\nTitle: Background process completed\nSeverity: info\n${taskId} completed.${extra}\n</notification>`;

function fold(records: readonly WireRecord[], fork?: ConversationFork, debug?: boolean): ConversationState {
  const state = createConversationState('main', fork, debug);
  for (const entry of records) applyConversationRecord(state, entry);
  return state;
}

function shape(turn: ConversationTurn | undefined): string[] {
  return (turn?.items ?? []).map((item) => {
    switch (item.type) {
      case 'user_message':
        return `${item.placement}:${item.text}`;
      case 'assistant_message':
      case 'reasoning':
        return `${item.type}:${item.text}`;
      case 'tool_call':
        return `tool:${item.item_id}:${item.status}`;
      case 'notification':
        return `notification:${item.notification_id}`;
      case 'system':
        return item.kind;
    }
  });
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe('conversation fold', () => {
  it('folds a turn into ordered items keyed by step and block and sums the ended steps', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'hello'),
      userMessage(undefined, '<system-reminder>', { kind: 'injection' }),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'think', think: 'plan', encrypted: 'sig' }, 0),
      contentPart(0, 1, 's1', { type: 'think', think: 'hidden', hidden: true }, 1),
      contentPart(0, 1, 's1', { type: 'text', text: 'answer' }, 2),
      toolCall(0, 1, 's1', 'call-1', 'Bash', { command: 'ls' }),
      toolResult('call-1', 'a\nb'),
      stepEnd(0, 1, 's1', {
        finishReason: 'tool_use',
        usage: { inputOther: 3, output: 2, inputCacheCreation: 1, raw: { provider: 'example' } },
        llmFirstTokenLatencyMs: 40,
        llmServerDecodeMs: 7,
      }),
      record('turn.step.retrying', {
        turnId: 0,
        step: 1,
        stepId: 's1',
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        delayMs: 0,
        errorName: 'APIStatusError',
        errorMessage: 'retry',
        statusCode: 429,
      }),
    ]);

    expect(state.turns[0]?.retry).toMatchObject({ attempt: 1, next_attempt: 2, max_attempts: 2 });
    applyConversationRecord(state, record('turn.step.started', { turnId: 0, step: 1, stepId: 's1' }));
    expect(state.turns[0]?.retry).toBeUndefined();
    for (const entry of [
      stepBegin(0, 2, 's2'),
      stepEnd(0, 2, 's2', { finishReason: 'end_turn', usage: { inputOther: 5, output: 1, inputCacheRead: 4, inputCacheCreation: 0 } }),
      turnEnded(0, 'completed', { durationMs: 120 }),
    ]) {
      applyConversationRecord(state, entry);
    }

    const [turn] = state.turns;
    expect(turn?.turn_id).toMatch(/^t_[0-9a-f]{12}$/);
    expect(turn).toMatchObject({
      ordinal: 0,
      turn_number: 0,
      kind: 'agent',
      status: 'ended',
      outcome: 'completed',
      duration_ms: 120,
      usage: { input_other: 8, output: 3, input_cache_read: 4, input_cache_creation: 1 },
    });
    expect(turn?.end_reason).toBeUndefined();
    expect(turn?.steps).toEqual([
      {
        index: 1,
        outcome: 'completed',
        started_at: expect.any(String),
        ended_at: expect.any(String),
        finish_reason: 'tool_use',
        usage: { input_other: 3, output: 2, input_cache_read: 0, input_cache_creation: 1 },
      },
      expect.objectContaining({ index: 2, outcome: 'completed', finish_reason: 'end_turn' }),
    ]);
    expect(shape(turn)).toEqual(['opener:hello', 'reasoning:plan', 'assistant_message:answer', 'tool:call-1:ended']);
    expect(turn?.items[0]).toEqual({
      type: 'user_message',
      item_id: 'p1',
      status: 'ended',
      outcome: 'completed',
      created_at: expect.any(String),
      prompt_ids: ['p1'],
      placement: 'opener',
      origin: { kind: 'user' },
      text: 'hello',
      attachments: [],
      skills: [],
    });
    expect(turn?.items.map((item) => item.item_id)).toEqual(['p1', 's1:0', 's1:2', 'call-1']);
    expect(turn?.items[3]).toMatchObject({ name: 'Bash', input: { command: 'ls' }, output: 'a\nb', outcome: 'completed', step_index: 1 });
  });

  it('attaches the request debug to the last item of each step only when debugging', () => {
    const records = [
      turnPrompt(0, 'p1'),
      userMessage('p1', 'hello'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'text', text: 'answer' }, 0),
      toolCall(0, 1, 's1', 'call-1', 'Bash', { command: 'ls' }),
      stepEnd(0, 1, 's1', {
        finishReason: 'tool_use',
        usage: { inputOther: 3, output: 2, inputCacheCreation: 1 },
        llmFirstTokenLatencyMs: 40,
        llmServerDecodeMs: 7,
      }),
    ];

    expect(fold(records).turns[0]?.items.map((item) => item.debug)).toEqual([undefined, undefined, undefined]);
    expect(fold(records, undefined, true).turns[0]?.items.map((item) => item.debug)).toEqual([
      undefined,
      undefined,
      {
        finish_reason: 'tool_use',
        usage: { input_other: 3, output: 2, input_cache_read: 0, input_cache_creation: 1 },
        timing: { first_token_ms: 40, server_decode_ms: 7 },
      },
    ]);
  });

  it('keeps visible user content and skill paths while hiding attachment server paths', () => {
    const fileId = 'f_0a1b2c3d-0000-4000-8000-000000000001';
    const state = fold([
      turnPrompt(0, 'p1'),
      record('context.append_message', {
        message: {
          role: 'user',
          id: 'p1',
          origin: {
            kind: 'user',
            clientMetadata: [{ display_text: 'check this diff' }],
            attachments: [{ name: 'notes.md', mediaType: 'text/markdown', size: 4, path: '/home/example/notes.md' }],
            skillActivations: [{ activationId: 'act-1', skillName: 'review', skillArgs: '--deep', skillPath: '/home/example/skills/review' }],
          },
          content: [
            { type: 'text', text: 'full review skill instructions' },
            { type: 'text', text: 'check this diff' },
            { type: 'text', text: 'and this', meta: { source: 'user prompt submit hook' } },
            { type: 'text', text: 'second line' },
            { type: 'text', text: `Attached file "notes.md" (text/markdown, 4 bytes): /home/example/attachments/${fileId}-notes.md — open it with the Read tool` },
            { type: 'text', text: 'Attached file "local.txt" (text/plain, 9 bytes): /home/example/local.txt — open it with the Read tool' },
            { type: 'text', text: '<system>Image compressed to fit model limits: original 3000x2000 image/png -> sent 2000x1333 image/png.</system>' },
            { type: 'text', text: `<video path="/home/example/cache/${fileId}.mp4"></video>` },
          ],
          toolCalls: [],
        },
      }),
    ]);

    const opener = state.turns[0]?.items[0];
    expect(opener).toMatchObject({
      type: 'user_message',
      origin: { kind: 'user' },
      text: 'check this diff\nsecond line',
      attachments: [
        { kind: 'file', file_id: fileId, name: 'notes.md', media_type: 'text/markdown', size: 4, ordinal: 1 },
        { kind: 'file', name: 'local.txt', media_type: 'text/plain', size: 9, ordinal: 2 },
        { kind: 'video', file_id: fileId, ordinal: 3 },
      ],
      skills: [{ name: 'review', path: '/home/example/skills/review', args: '--deep' }],
      metadata: { display_text: 'check this diff' },
    });
    expect(JSON.stringify(opener)).not.toContain('/home/example/notes.md');
    expect(JSON.stringify(opener)).not.toContain('/home/example/local.txt');
  });

  it('maps engine origins to protocol origins and gives system-triggered inputs no prompt ids', () => {
    const state = fold([
      userMessage('k1', 'User activated the skill', {
        kind: 'skill_activation',
        trigger: 'user-slash',
        activationId: 'act-2',
        skillName: 'commit',
        skillArgs: '-m wip',
        skillPath: '/home/example/skills/commit',
      }),
      userMessage('c1', 'Plugin command', {
        kind: 'plugin_command',
        trigger: 'user-slash',
        activationId: 'act-3',
        pluginId: 'example-plugin',
        commandName: 'deploy',
        commandArgs: 'staging',
      }),
      turnPrompt(1, 'p2', { kind: 'retry', trigger: 'provider_error' }),
      userMessage('p2', 'retry the previous request', { kind: 'retry', trigger: 'provider_error' }),
      userMessage('g1', 'Continue working toward the active goal', { kind: 'system_trigger', name: 'goal_continuation' }),
      userMessage(undefined, 'Report back to the parent agent', { kind: 'system_trigger', name: 'subagent' }),
      turnPrompt(2, 'cron-1', { kind: 'cron_job' }),
      userMessage('cron-1', '<cron-fire jobId="job-1" cron="0 3 * * *" recurring="true" coalescedCount="2" stale="false">\n<prompt>\nnightly report\n</prompt>\n</cron-fire>', {
        kind: 'cron_job',
        jobId: 'job-1',
        cron: '0 3 * * *',
        recurring: true,
        coalescedCount: 2,
        stale: false,
      }),
      turnPrompt(6, 'cron-nested', { kind: 'cron_job' }),
      userMessage('cron-nested', '<cron-fire jobId="job-3" cron="0 * * * *" recurring="true" coalescedCount="1" stale="false">\n<prompt>\nSummarize:\n<prompt>\ninner\n</prompt>\n</prompt>\n</cron-fire>', {
        kind: 'cron_job',
        jobId: 'job-3',
        cron: '0 * * * *',
        recurring: true,
      }),
      turnPrompt(3, 'cron-legacy', { kind: 'cron_job' }),
      userMessage('cron-legacy', 'weekly digest', { kind: 'cron_job', jobId: 'job-2', cron: '0 9 * * 1', recurring: true }),
      turnPrompt(4, 'missed', { kind: 'cron_missed' }),
      userMessage('missed', 'missed runs', { kind: 'cron_missed', count: 2 }),
      turnPrompt(5, 'hook-1', { kind: 'hook_result' }),
      userMessage('hook-1', 'hook output', { kind: 'hook_result', event: 'SessionStart' }),
    ]);

    const openers = state.turns.map((turn) => turn.items[0]);
    expect(openers.map((item) => (item?.type === 'user_message' ? [item.origin, item.prompt_ids, item.text] : []))).toEqual([
      [{ kind: 'skill', name: 'commit', path: '/home/example/skills/commit', args: '-m wip' }, ['k1'], 'User activated the skill'],
      [{ kind: 'plugin_command', plugin_id: 'example-plugin', command: 'deploy', args: 'staging' }, ['c1'], 'Plugin command'],
      [{ kind: 'retry' }, [], ''],
      [{ kind: 'goal' }, [], ''],
      [{ kind: 'system' }, [], 'Report back to the parent agent'],
      [{ kind: 'cron', job_id: 'job-1', schedule: '0 3 * * *', recurring: true, coalesced_count: 2, stale: false }, [], 'nightly report'],
      [{ kind: 'cron', job_id: 'job-3', schedule: '0 * * * *', recurring: true, coalesced_count: 1, stale: false }, [], 'Summarize:\n<prompt>\ninner\n</prompt>'],
      [{ kind: 'cron', job_id: 'job-2', schedule: '0 9 * * 1', recurring: true, coalesced_count: 1, stale: false }, [], 'weekly digest'],
      [{ kind: 'system' }, [], 'missed runs'],
      [{ kind: 'hook', hook_event: 'SessionStart' }, [], 'hook output'],
    ]);
  });

  it('shows CLI shell commands as their raw text in ended turns and hides injections', () => {
    const state = fold([
      userMessage(undefined, '<bash-input>\nls\n</bash-input>', { kind: 'shell_command', phase: 'input' }),
      userMessage(undefined, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>', { kind: 'shell_command', phase: 'output' }),
      userMessage(undefined, '<system-reminder>', { kind: 'injection', variant: 'example' }),
    ]);

    expect(state.turns.map((turn) => [turn.status, turn.items.map((item) => (item.type === 'user_message' ? [item.origin, item.text] : item.type))])).toEqual([
      ['ended', [[{ kind: 'system' }, '<bash-input>\nls\n</bash-input>']]],
      ['ended', [[{ kind: 'system' }, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>']]],
    ]);
    expect(state.openTurnId).toBeUndefined();
  });

  it('maps engine turn ends to outcomes and end reasons', () => {
    const failed = (code: string): Record<string, unknown> => ({ error: { code, message: code, retryable: false } });
    const state = fold([
      turnPrompt(0, 'p0'), userMessage('p0', 'a'), turnEnded(0, 'completed'),
      turnPrompt(1, 'p1'), userMessage('p1', 'b'), turnEnded(1, 'cancelled'),
      turnPrompt(2, 'p2'), userMessage('p2', 'c'), record('turn.cancel', { turnId: 2, target: 'active', reason: 'aborted' }), turnEnded(2, 'cancelled'),
      turnPrompt(3, 'p3'), userMessage('p3', 'd'), turnEnded(3, 'failed', failed('loop.max_steps_exceeded')),
      turnPrompt(4, 'p4'), userMessage('p4', 'e'), turnEnded(4, 'failed', failed('provider.filtered')),
      turnPrompt(5, 'p5'), userMessage('p5', 'f'), turnEnded(5, 'failed', failed('provider.rate_limit')),
      turnPrompt(6, 'p6'), userMessage('p6', 'g'), turnEnded(6, 'blocked'),
      userMessage('p7', 'blocked input'), record('prompt.completed', { promptId: 'p7', reason: 'blocked' }),
    ]);

    expect(state.turns.map((turn) => `${turn.outcome}/${turn.end_reason ?? ''}/${turn.error?.code ?? ''}`)).toEqual([
      'completed//',
      'interrupted/user_cancelled/',
      'interrupted/aborted/',
      'failed/max_steps/loop.max_steps_exceeded',
      'failed/filtered/provider.filtered',
      'failed/error/provider.rate_limit',
      'failed/blocked/',
      'failed/blocked/',
    ]);
  });

  it('gives turns ids that stay stable across a replay and differ after an undo reuses their ordinal', () => {
    const first = [turnPrompt(0, 'p1'), userMessage('p1', 'first'), turnEnded(0, 'completed')];
    const original = fold(first).turns[0]!;
    expect(fold(first).turns[0]?.turn_id).toBe(original.turn_id);

    const afterUndo = fold([turnPrompt(0, 'p2'), userMessage('p2', 'second'), turnEnded(0, 'completed')]).turns[0]!;
    expect(afterUndo.ordinal).toBe(original.ordinal);
    expect(afterUndo.turn_id).not.toBe(original.turn_id);

    const other = createConversationState('agent-other');
    for (const entry of first) applyConversationRecord(other, entry);
    expect(other.turns[0]?.turn_id).not.toBe(original.turn_id);
  });

  it('times reasoning by its streamed block and leaves untimed records without a duration', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'hello'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'think', think: 'timed' }, 0, { startedAt: 5_000, durationMs: 1_200 }),
      contentPart(0, 1, 's1', { type: 'think', think: 'untimed' }, 1),
    ]);

    const turn = state.turns[0];
    const stepStart = iso(state.steps[turn!.turn_id]![0]!.startedAt);
    expect(turn?.items[1]).toMatchObject({ type: 'reasoning', created_at: iso(5_000), started_at: iso(5_000), duration_ms: 1_200 });
    expect(turn?.items[2]).toMatchObject({ type: 'reasoning', started_at: stepStart });
    expect(turn?.items[2]).toEqual(expect.not.objectContaining({ duration_ms: expect.anything() }));
  });

  it('places in-turn steers and legacy steer records inside the running turn', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'first'),
      stepBegin(0, 1, 's1'),
      userMessage('p2', 'steer now', { kind: 'user', inTurn: true }),
      record('turn.steer', { turnId: 0, messageId: 'p2', promptIds: ['p2', 'p3'] }),
      record('turn.steer', { input: [{ type: 'text', text: 'legacy steer' }], origin: { kind: 'user' } }),
      userMessage('p4', 'legacy steer'),
      userMessage('s1', 'Skill tool loaded instructions', { kind: 'skill_activation', trigger: 'model-tool', inTurn: true }),
      turnEnded(0, 'completed'),
    ]);

    expect(state.turns).toHaveLength(1);
    expect(shape(state.turns[0])).toEqual(['opener:first', 'steer:steer now', 'steer:legacy steer']);
    expect(state.turns[0]?.items[1]).toMatchObject({ prompt_ids: ['p2', 'p3'] });
  });

  it('keeps task notifications in the running turn and opens a turn for task prompts', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'work'),
      stepBegin(0, 1, 's1'),
      userMessage(undefined, notificationXml('a', '\n<output-file path="/tmp/a.log" bytes="123">\nRead output.\n</output-file>'), { kind: 'task', taskId: 'a' }),
      turnEnded(0, 'completed'),
      turnPrompt(1, undefined, { kind: 'task', taskId: 'b' }),
      userMessage(undefined, notificationXml('b'), { kind: 'task', taskId: 'b' }),
      stepBegin(1, 1, 's2'),
      turnEnded(1, 'completed'),
      userMessage('n-c', `${notificationXml('c')}\n\n${notificationXml('d')}`, { kind: 'task', taskId: 'c' }),
    ]);

    expect(state.turns.map(shape)).toEqual([
      ['opener:work', 'notification:task:a:completed'],
      ['notification:task:b:completed'],
      ['notification:task:c:completed', 'notification:task:d:completed'],
    ]);
    expect(state.turns[1]).toMatchObject({ turn_number: 1, status: 'ended' });
    expect(state.turns[2]).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(state.turns[2]?.items.map((item) => item.item_id)).toEqual(['n-c', 'n-c:1']);
    expect(state.turns[0]?.items[1]).toMatchObject({ output: { file: '/tmp/a.log', bytes: 123 } });
  });

  it('reads the answer of a background question into structured fields', () => {
    const answer = '\n<answer>\n{"answers":{"Pick one?":"B"},"note":"because"}\n</answer>';
    const state = fold([userMessage(undefined, notificationXml('question-1', answer), { kind: 'task', taskId: 'question-1' })]);

    expect(state.turns[0]?.items[0]).toMatchObject({ type: 'notification', answer: { answers: { 'Pick one?': 'B' }, note: 'because' } });
    expect(state.turns[0]?.items[0]).toEqual(expect.not.objectContaining({ output: expect.anything() }));
  });

  it('attaches an approval to the new call when an ended call of an earlier turn reused its id', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'first'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'Bash_1', 'Bash', { command: 'ls' }),
      toolResult('Bash_1', 'ok'),
      turnEnded(0, 'completed'),
      turnPrompt(1, 'p2'),
      userMessage('p2', 'second'),
      stepBegin(1, 1, 's2'),
      record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'Bash_1', request: { toolName: 'Bash', turnId: 1 } }),
    ]);

    expect(state.turns[0]?.items[1]).toEqual(expect.not.objectContaining({ interaction_id: expect.anything() }));
    expect(state.turns[1]?.items[1]).toMatchObject({ item_id: 'Bash_1', stage: 'awaiting_approval', interaction_id: 'i1' });
  });

  it('starts a call that reuses an ended call id without that call approval', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'first'),
      stepBegin(0, 1, 's1'),
      record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'Bash_1', request: { toolName: 'Bash', turnId: 0 } }),
      record('interaction.resolved', { id: 'i1', response: { decision: 'approved' } }),
      toolCall(0, 1, 's1', 'Bash_1', 'Bash', { command: 'ls' }),
      toolResult('Bash_1', 'ok'),
      turnEnded(0, 'completed'),
      turnPrompt(1, 'p2'),
      userMessage('p2', 'second'),
      stepBegin(1, 1, 's2'),
      toolCall(1, 1, 's2', 'Bash_1', 'Bash', { command: 'pwd' }),
    ]);

    expect(state.turns[0]?.items[1]).toMatchObject({ item_id: 'Bash_1', interaction_id: 'i1' });
    expect(state.turns[1]?.items[1]).toEqual(expect.not.objectContaining({ interaction_id: expect.anything() }));
  });

  it('interrupts a call left without a result and restarts ordinals after a clear', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'first'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'call-1', 'Bash', { command: 'ls' }),
      turnEnded(0, 'completed'),
      record('context.clear', {}),
      turnPrompt(1, 'p2'),
      userMessage('p2', 'second'),
    ]);

    expect(state.turns.map((turn) => turn.ordinal)).toEqual([0]);
    const cleared = fold([turnPrompt(0, 'p1'), userMessage('p1', 'first'), stepBegin(0, 1, 's1'), toolCall(0, 1, 's1', 'call-1', 'Bash'), turnEnded(0, 'completed')]);
    expect(cleared.turns[0]?.items[1]).toMatchObject({ item_id: 'call-1', status: 'ended', outcome: 'interrupted' });
  });

  it('attaches interactions recorded before the tool call and subagent links to tool items', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'plan it'),
      stepBegin(0, 1, 's1'),
      record('interaction.request', {
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        request: { display: { kind: 'plan_review', plan: '# Plan', path: '/plans/a.md', options: [{ label: 'Go' }, { label: 'Wait', description: 'later' }] } },
      }),
      record('interaction.resolved', { id: 'i1', response: { decision: 'approved', selectedLabel: 'Go' } }),
      toolCall(0, 1, 's1', 'call-1', 'ExitPlanMode'),
      toolCall(0, 1, 's1', 'call-2', 'Agent'),
      record('subagent.spawned', { subagentId: 'agent-0', subagentName: 'explore', parentToolCallId: 'call-2', runInBackground: false, swarmIndex: 1, taskId: 'task-1' }),
      record('subagent.spawned', { subagentId: 'agent-1', subagentName: 'explore', parentToolCallId: 'call-2', runInBackground: true }),
    ]);

    const items = state.turns[0]?.items ?? [];
    expect(items[1]).toMatchObject({
      type: 'tool_call',
      interaction_id: 'i1',
      stage: 'executing',
      display: {
        kind: 'plan_review',
        plan: '# Plan',
        path: '/plans/a.md',
        options: [{ label: 'Go', description: '' }, { label: 'Wait', description: 'later' }],
        review: { state: 'approved', selected_option: 'Go' },
      },
    });
    expect(items[2]).toMatchObject({
      type: 'tool_call',
      agent_refs: [
        { agent_id: 'agent-0', role: 'member', swarm_index: 1, task_id: 'task-1' },
        { agent_id: 'agent-1', role: 'child' },
      ],
    });
  });

  it('reviews a plan as pending while it waits and as rejected with the feedback once answered', () => {
    const records = [
      turnPrompt(0, 'p1'),
      userMessage('p1', 'plan it'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'call-1', 'ExitPlanMode'),
      record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'call-1', request: { display: { kind: 'plan_review', plan: '# Plan' } } }),
    ];
    const pending = fold(records);
    expect(pending.turns[0]?.items[1]).toMatchObject({ stage: 'awaiting_approval', display: { review: { state: 'pending' } } });

    applyConversationRecord(pending, record('interaction.resolved', { id: 'i1', response: { decision: 'rejected', feedback: 'Cover the error path too.' } }));
    expect(pending.turns[0]?.items[1]).toMatchObject({
      stage: 'executing',
      display: { kind: 'plan_review', plan: '# Plan', options: [], review: { state: 'rejected', feedback: 'Cover the error path too.' } },
    });

    const legacy = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'plan it'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'call-1', 'ExitPlanMode'),
      toolResult('call-1', 'Plan saved to: /plans/b.md\n## Approved Plan:\n# Old plan'),
    ]);
    expect(legacy.turns[0]?.items[1]).toMatchObject({
      display: { kind: 'plan_review', plan: '# Old plan', path: '/plans/b.md', review: { state: 'approved' } },
    });
  });

  it('shows completed compactions only, between turns as a system turn and inside a running turn as an item', () => {
    const state = fold([
      record('full_compaction.begin', { source: 'manual', instruction: 'keep the migration notes' }),
      record('context.apply_compaction', { summary: 'short', compactedCount: 4, tokensBefore: 100, tokensAfter: 10 }),
      record('full_compaction.complete', {}),
      turnPrompt(0, 'p1'),
      userMessage('p1', 'go'),
      stepBegin(0, 1, 's1'),
      record('full_compaction.begin', { source: 'auto' }),
      record('full_compaction.cancel', {}),
      record('full_compaction.begin', { source: 'auto' }),
      record('context.apply_compaction', { summary: 'mid-turn', compactedCount: 2, tokensBefore: 90, tokensAfter: 30 }),
      record('full_compaction.complete', {}),
      turnEnded(0, 'completed'),
      record('context.apply_compaction', { summary: 'legacy', compactedCount: 2 }),
    ]);

    const turns = state.turns;
    expect(turns.map((turn) => `${turn.kind}:${turn.status}:${turn.outcome}`)).toEqual([
      'system:ended:completed',
      'agent:ended:completed',
      'system:ended:completed',
    ]);
    expect(turns[0]?.items).toEqual([{
      type: 'system',
      item_id: `${turns[0]!.turn_id}#0`,
      status: 'ended',
      outcome: 'completed',
      created_at: expect.any(String),
      kind: 'compaction',
      trigger: 'manual',
      instruction: 'keep the migration notes',
      tokens_before: 100,
      tokens_after: 10,
      compacted_count: 4,
      summary: 'short',
    }]);
    expect(shape(turns[1])).toEqual(['opener:go', 'compaction']);
    expect(turns[1]?.items[1]).toMatchObject({ trigger: 'auto', summary: 'mid-turn' });
    expect(turns[2]?.items[0]).toMatchObject({ kind: 'compaction', trigger: 'auto', summary: 'legacy' });
  });

  it('opens a forked conversation with a boundary turn and hides what it inherited', () => {
    const state = fold([
      userMessage('m1', 'inherited question'),
      message('assistant', 'inherited answer'),
      userMessage(undefined, '<system-reminder>side question</system-reminder>', { kind: 'injection', variant: 'btw' }),
      turnPrompt(0, 'p1'),
      userMessage('p1', 'what does this do?'),
      turnEnded(0, 'completed'),
    ], { source: 'btw', forkedFrom: 'main' });

    const turns = state.turns;
    expect(turns.map((turn) => `${turn.kind}:${turn.ordinal}`)).toEqual(['system:0', 'agent:1']);
    expect(turns[0]?.items).toEqual([expect.objectContaining({ type: 'system', kind: 'fork_boundary', source: 'btw', forked_from: { agent_id: 'main' } })]);
    expect(shape(turns[1])).toEqual(['opener:what does this do?']);
    expect(JSON.stringify(turns)).not.toContain('inherited');
  });

  it('keeps the turns of a fork unique and in order when its own turn numbers start from zero', () => {
    const ownIds = [0, 1, 2, 3];
    const state = fold([
      userMessage('inherited', 'inherited prompt'),
      message('assistant', 'inherited answer'),
      ...ownIds.flatMap((id) => [
        turnPrompt(id, `p${id}`),
        userMessage(`p${id}`, `prompt ${id}`),
        message('assistant', `answer ${id}`),
        turnEnded(id, 'completed'),
      ]),
    ], { source: 'fork', forkedFrom: 'main' });

    const turns = state.turns;
    const own = turns.filter((turn) => turn.kind === 'agent');
    expect(own.map((turn) => shape(turn))).toEqual(
      ownIds.map((id) => [`opener:prompt ${id}`, `assistant_message:answer ${id}`]),
    );
    expect(own.map((turn) => turn.turn_number)).toEqual(ownIds);
    expect(new Set(turns.map((turn) => turn.turn_id)).size).toBe(turns.length);
    const ordinals = turns.map((turn) => turn.ordinal);
    expect(ordinals).toEqual(ordinals.toSorted((a, b) => a - b));
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('keeps the newer turn open when a cancelled turn it interleaved with ends', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'first'),
      stepBegin(0, 1, 's1'),
      record('turn.cancel', { turnId: 0, reason: 'user' }),
      turnPrompt(1, 'p2'),
      userMessage('p2', 'second'),
      stepBegin(0, 2, 's1b'),
      turnEnded(0, 'cancelled'),
      stepBegin(1, 1, 's2'),
      userMessage('steer', 'more', { kind: 'user', inTurn: true }),
    ]);

    expect(state.turns).toHaveLength(2);
    expect(shape(state.turns[1])).toEqual(['opener:second', 'steer:more']);
  });

  it('ends the tool calls a stop cuts short as interrupted and keeps earlier results as they were', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'run them'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'Read_0', 'Read', { path: 'a.ts' }),
      toolCall(0, 1, 's1', 'Read_1', 'Read', { path: 'missing.ts' }),
      toolCall(0, 1, 's1', 'Bash_2', 'Bash', { command: 'sleep 60' }),
      toolCall(0, 1, 's1', 'Bash_3', 'Bash', { command: 'make' }),
      toolResult('Read_0', 'file body'),
      toolResult('Read_1', 'file not found', true),
      record('turn.cancel', { turnId: 0, target: 'active', reason: 'user' }),
      toolResult('Bash_2', 'Interrupted by user', true),
      toolResult('Bash_3', 'The user manually interrupted "Bash".', true),
      turnEnded(0, 'cancelled'),
    ]);

    const items = state.turns[0]?.items ?? [];
    expect(state.turns[0]).toMatchObject({ outcome: 'interrupted' });
    expect(items[1]).toMatchObject({ item_id: 'Read_0', outcome: 'completed', output: 'file body' });
    expect(items[2]).toMatchObject({ item_id: 'Read_1', outcome: 'failed', error: 'file not found' });
    expect(items[3]).toMatchObject({ item_id: 'Bash_2', outcome: 'interrupted', error: 'Interrupted by user' });
    expect(items[4]).toMatchObject({ item_id: 'Bash_3', outcome: 'interrupted' });
    expect(items[3]).not.toHaveProperty('output', expect.anything());
  });

  it('keeps tool errors failed when the step failed instead of being stopped', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'run it'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'Bash_0', 'Bash', { command: 'make' }),
      record('turn.step.interrupted', { turnId: 0, step: 1, stepId: 's1', reason: 'error' }),
      toolResult('Bash_0', 'Tool "Bash" was aborted', true),
      turnEnded(0, 'failed', { error: { name: 'ProviderError', message: 'boom' } }),
    ]);

    expect(state.turns[0]?.items[1]).toMatchObject({ item_id: 'Bash_0', outcome: 'failed' });
  });

  it('replaces the partial reply of a failed attempt with the attempt that retries its step', () => {
    const failedAttempt = [
      turnPrompt(0, 'p1'),
      userMessage('p1', 'Which regions?'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'text', text: 'Affected: eu-west ' }, 0),
      stepEnd(0, 1, 's1', { finishReason: 'error' }),
    ];

    const retried = fold([
      ...failedAttempt,
      stepBegin(0, 1, 's2'),
      contentPart(0, 1, 's2', { type: 'text', text: 'Affected regions are eu-west and us-east.' }, 0),
      stepEnd(0, 1, 's2', { finishReason: 'end_turn' }),
      turnEnded(0, 'completed'),
    ]);
    const exhausted = fold([...failedAttempt, turnEnded(0, 'failed', { error: { name: 'APIConnectionError', message: 'terminated' } })]);

    expect(shape(retried.turns[0])).toEqual(['opener:Which regions?', 'assistant_message:Affected regions are eu-west and us-east.']);
    expect(shape(exhausted.turns[0])).toEqual(['opener:Which regions?', 'assistant_message:Affected: eu-west ']);
  });

  it('keeps the note of a tool result beside its output', () => {
    const note = 'Read image file. Mime type: image/png. Size: 1234 bytes. Original dimensions: 640x480 pixels.';
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'look'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'ReadMediaFile_0', 'ReadMediaFile', { path: '/tmp/a.png' }),
      toolCall(0, 1, 's1', 'Read_1', 'Read', { path: 'a.ts' }),
      loop({
        type: 'tool.result',
        toolCallId: 'ReadMediaFile_0',
        result: {
          output: [
            { type: 'text', text: '<image path="/tmp/a.png">' },
            { type: 'text', text: '</image>' },
          ],
          note,
        },
      }),
      toolResult('Read_1', 'file body'),
    ]);

    const items = state.turns[0]?.items ?? [];
    expect(items[1]).toMatchObject({ item_id: 'ReadMediaFile_0', outcome: 'completed', output: '<image path="/tmp/a.png"></image>', note });
    expect(items[2]).toMatchObject({ item_id: 'Read_1', output: 'file body' });
    expect(items[2]).not.toHaveProperty('note', expect.anything());
  });

  it('links each tool call to the task it runs as', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'start the server, audit, and ask'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'Bash_0', 'Bash', { command: 'npm run dev', run_in_background: true }),
      record('task.started', { info: { kind: 'process', taskId: 'bash-k3f9', parentToolCallId: 'Bash_0' } }),
      toolCall(0, 1, 's1', 'Agent_1', 'Agent', { prompt: 'audit the docs' }),
      record('task.started', { info: { kind: 'agent', taskId: 'agent-1', parentToolCallId: 'Agent_1' } }),
      toolCall(0, 1, 's1', 'Ask_2', 'AskUserQuestion', { questions: [] }),
      record('task.started', { info: { kind: 'question', taskId: 'question-1', toolCallId: 'Ask_2' } }),
      record('task.started', { info: { kind: 'process', taskId: 'bash-other', parentToolCallId: 'Bash_9' } }),
      toolResult('Bash_0', 'task_id: bash-k3f9\nstatus: running'),
    ]);

    const byId = new Map((state.turns[0]?.items ?? []).map((item) => [item.item_id, item]));
    expect(byId.get('Bash_0')).toMatchObject({ task_id: 'bash-k3f9', outcome: 'completed' });
    expect(byId.get('Agent_1')).toMatchObject({ task_id: 'agent-1' });
    expect(byId.get('Ask_2')).toMatchObject({ task_id: 'question-1' });
    expect([...byId.keys()]).not.toContain('Bash_9');
  });

  it('keeps a running turn open while ownerless messages land beside it', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'work'),
      stepBegin(0, 1, 's1'),
      userMessage(undefined, 'a note from the CLI'),
      userMessage(undefined, 'another note'),
    ]);
    expect(state.turns.map((turn) => turn.status)).toEqual(['running', 'ended', 'ended']);
    expect(state.openTurnId).toBe(state.turns[0]?.turn_id);

    for (const entry of [contentPart(0, 1, 's1', { type: 'text', text: 'done' }, 0), stepEnd(0, 1, 's1'), turnEnded(0, 'completed')]) {
      applyConversationRecord(state, entry);
    }

    expect(state.turns.map((turn) => `${turn.turn_number}:${turn.outcome}`)).toEqual([
      '0:completed',
      'undefined:completed',
      'undefined:completed',
    ]);
    expect(shape(state.turns[0])).toEqual(['opener:work', 'assistant_message:done']);
  });

  it('undoes legacy records at message granularity', () => {
    const state = fold([
      turnPrompt(undefined, undefined),
      userMessage('a', 'first'),
      message('assistant', 'one'),
      turnPrompt(undefined, undefined),
      userMessage('b', 'second'),
      message('assistant', 'two'),
      record('turn.steer', { input: [{ type: 'text', text: 'wait' }], origin: { kind: 'user' } }),
      userMessage('c', 'wait'),
      message('assistant', 'three'),
    ]);
    undoConversationTurns(state, 1);
    undoConversationTurns(state, 1);
    applyConversationRecord(state, turnPrompt(undefined, undefined));
    applyConversationRecord(state, userMessage('d', 'third'));

    expect(state.turns.map(shape)).toEqual([
      ['opener:first', 'assistant_message:one'],
      ['opener:third'],
    ]);
  });

  it('forgets the tool bookkeeping of undone turns so a reused call id starts clean', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'first'),
      turnEnded(0, 'completed'),
      turnPrompt(1, 'p2'),
      userMessage('p2', 'second'),
      stepBegin(1, 1, 's1'),
      toolCall(1, 1, 's1', 'Bash:0', 'Bash', { command: 'ls' }),
      turnEnded(1, 'completed'),
    ]);
    expect(state.tools['Bash:0']).toBeDefined();

    undoConversationTurns(state, 1);

    expect(state.turns).toHaveLength(1);
    expect(state.tools['Bash:0']).toBeUndefined();
  });

  it('folds legacy assistant and tool messages', () => {
    const state = fold([
      turnPrompt(undefined, undefined),
      userMessage('a', 'read it'),
      record('context.append_message', {
        message: {
          role: 'assistant',
          content: [{ type: 'think', think: 'hmm' }, { type: 'text', text: 'reading' }],
          toolCalls: [{ type: 'function', id: 'Read_0', name: 'Read', arguments: '{"path":"a.ts"}' }],
        },
      }),
      record('context.append_message', {
        message: { role: 'tool', toolCallId: 'Read_0', content: [{ type: 'text', text: 'file body' }], isError: true },
      }),
    ]);

    expect(shape(state.turns[0])).toEqual(['opener:read it', 'reasoning:hmm', 'assistant_message:reading', 'tool:Read_0:ended']);
    expect(state.turns[0]?.items[3]).toMatchObject({ input: { path: 'a.ts' }, outcome: 'failed', error: 'file body' });
  });
});

describe('orphan turns', () => {
  const unfinished = (): WireRecord[] => [
    turnPrompt(1, 'p2'),
    userMessage('p2', 'run it'),
    stepBegin(1, 1, 's1'),
    toolCall(1, 1, 's1', 'call-1', 'Bash', { command: 'ls' }),
    record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'call-1', request: {} }),
  ];

  it('ends a running turn nothing runs anymore as aborted, with its items, without touching the input', () => {
    const state = fold([turnPrompt(0, 'p1'), userMessage('p1', 'first'), turnEnded(0, 'completed'), ...unfinished()]);
    const before = structuredClone(state);

    const settled = settleOrphanTurns(state);

    expect(state).toEqual(before);
    expect(settled.turns[1]).toMatchObject({ status: 'ended', outcome: 'interrupted', end_reason: 'aborted', ended_at: iso(state.clock) });
    expect(settled.turns[1]?.items[1]).toMatchObject({ status: 'ended', outcome: 'interrupted', interaction_id: 'i1' });
    expect(settled.openTurnId).toBeUndefined();
  });

  it('ends the last turn of a conversation whose engine never recorded turn ends as completed', () => {
    const settled = settleOrphanTurns(fold(unfinished()));

    expect(settled.turns[0]).toMatchObject({ status: 'ended', outcome: 'completed' });
  });
});

const passThroughBlobs = {
  offloadParts: async (parts: readonly ContentPart[]) => parts,
  loadParts: async (parts: readonly ContentPart[]) => parts,
  isBlobRef: (url: string) => url.startsWith('blobref:'),
} as unknown as IAgentBlobService;

function emptyView<T>(): CollectionView<T> {
  return { items: [], records: [], onDidChange: () => ({ dispose: () => {} }) } as unknown as CollectionView<T>;
}

interface FeedHarness {
  readonly dispatcher: EventDispatcherService;
  readonly feed: ConversationFeed;
  readonly events: ConversationEvent[];
  readonly warn: ReturnType<typeof vi.fn>;
  failNextReplay(): void;
  holdNextReplay(): { readonly reached: Promise<void>; readonly release: () => void };
  rewind(length: number): void;
}

function feedHarness(records: readonly WireRecord[], blobs: IAgentBlobService = passThroughBlobs): FeedHarness {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const logger = log as unknown as ILogService;
  const journal = [...records];
  let failReplay = false;
  let hold: { readonly reach: () => void; readonly released: Promise<void> } | undefined;
  const wire = {
    appendRecord: (entry: WireRecord) => {
      journal.push(entry);
    },
    flush: async () => {},
    readRestoreChains: async () => {
      const held = hold;
      hold = undefined;
      if (held !== undefined) {
        held.reach();
        await held.released;
      }
      if (failReplay) {
        failReplay = false;
        throw new Error('wire read failed');
      }
      return { restorable: [...journal], journal: [...journal] };
    },
  } as unknown as IWireService;
  const scope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' });
  const bus = new EventBusService();
  bus.activateAgent(scope.agentContext);
  const dispatcher = new EventDispatcherService(wire, bus, scope, blobs, new AgentStateService(), logger, emptyView(), emptyView());
  const services = new Map<unknown, unknown>([
    [IEventBus, bus],
    [IEventDispatcher, dispatcher],
    [IAgentBlobService, blobs],
    [IAgentLoopService, { snapshot: () => ({ state: 'idle' }) }],
    [ILogService, logger],
  ]);
  const handle = { id: 'main', accessor: { get: (id: unknown) => services.get(id) } } as unknown as IAgentScopeHandle;
  const feed = new ConversationFeed(handle);
  const events: ConversationEvent[] = [];
  feed.subscribe((event) => events.push(event));
  return {
    dispatcher,
    feed,
    events,
    warn: log.warn,
    failNextReplay: () => {
      failReplay = true;
    },
    holdNextReplay: () => {
      let reach!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { reach, released };
      return { reached, release };
    },
    rewind: (length) => {
      journal.splice(length);
    },
  };
}

const prompt = (turnId: number, promptId: string): TurnPrompt =>
  new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' }, promptId, turnId });

const userPrompt = (id: string, text: string): ContextAppendMessage =>
  new ContextAppendMessage({ agentId: 'main', message: { role: 'user', id, content: [{ type: 'text', text }], origin: { kind: 'user' } } });

const loopEvent = (event: LoopRecordedEvent): ContextAppendLoopEvent => new ContextAppendLoopEvent({ agentId: 'main', event });

const updated = (
  fields: Readonly<Record<string, unknown>>,
  output?: { offset: number; text: string },
): ToolUpdated => new ToolUpdated({
  agentId: 'main',
  turnId: 0,
  toolCallId: 'call-1',
  taskId: 'task-1',
  status: 'running',
  detached: false,
  fields,
  output,
});

const flushed = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function runningTurn(h: FeedHarness): Promise<void> {
  await h.dispatcher.restore();
  await h.feed.ready;
  await h.dispatcher.dispatch(prompt(0, 'p1'));
  await h.dispatcher.dispatch(userPrompt('p1', 'run it'));
  await h.dispatcher.dispatch(loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }));
  await flushed();
  h.events.length = 0;
}

describe('conversation feed', () => {
  it('rejects ready when the first replay fails', async () => {
    const h = feedHarness([prompt(0, 'p1').serialize()]);
    h.failNextReplay();
    const ready = expect(h.feed.ready).rejects.toThrow('agent main failed to restore its conversation');

    await expect(h.dispatcher.restore()).rejects.toThrow('wire read failed');

    await ready;
    h.dispatcher.dispose();
  });

  it('keeps streaming after a rerun restore that no undo completion follows, and keeps its conversation when a rerun fails', async () => {
    const h = feedHarness([
      prompt(0, 'p1').serialize(),
      userPrompt('p1', 'first').serialize(),
      new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }).serialize(),
    ]);
    await h.dispatcher.restore();
    await h.feed.ready;
    const before = (await h.feed.page(undefined, 20)).turns.map((turn) => turn.turn_id);

    await h.dispatcher.restore();
    expect(h.events).toEqual([]);
    expect((await h.feed.page(undefined, 20)).turns.map((turn) => turn.turn_id)).toEqual(before);
    await h.dispatcher.dispatch(prompt(1, 'p2'));
    await h.dispatcher.dispatch(userPrompt('p2', 'second'));
    await flushed();
    expect(h.events.map((event) => event.type)).toEqual(['turn.started', 'item.ended']);

    const kept = (await h.feed.page(undefined, 20)).turns.map((turn) => turn.turn_id);
    h.failNextReplay();
    h.events.length = 0;
    await expect(h.dispatcher.restore()).rejects.toThrow('wire read failed');
    expect(h.events.map((event) => event.type)).toEqual(['turn.ended']);
    expect(kept).toHaveLength(2);
    expect((await h.feed.page(undefined, 20)).turns.map((turn) => `${turn.turn_id}:${turn.outcome}`)).toEqual([
      `${kept[0]}:completed`,
      `${kept[1]}:interrupted`,
    ]);
    h.events.length = 0;
    await h.dispatcher.dispatch(prompt(2, 'p3'));
    await h.dispatcher.dispatch(userPrompt('p3', 'third'));
    await flushed();
    expect(h.events.map((event) => event.type)).toEqual(['turn.started', 'item.ended']);
    h.dispatcher.dispose();
  });

  it('removes the turns a replay no longer has and every turn on a context clear', async () => {
    const h = feedHarness([
      prompt(0, 'p1').serialize(),
      userPrompt('p1', 'first').serialize(),
      new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }).serialize(),
    ]);
    await h.dispatcher.restore();
    await h.feed.ready;
    await h.dispatcher.dispatch(prompt(1, 'p2'));
    await h.dispatcher.dispatch(userPrompt('p2', 'second'));
    await h.dispatcher.dispatch(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }));
    await flushed();
    const [first, second] = (await h.feed.page(undefined, 20)).turns.map((turn) => turn.turn_id);
    h.events.length = 0;

    h.rewind(3);
    await h.dispatcher.restore();
    expect(h.events).toEqual([{ type: 'turns.removed', turn_ids: [second] }]);
    expect((await h.feed.page(undefined, 20)).turns.map((turn) => turn.turn_id)).toEqual([first]);

    h.events.length = 0;
    await h.dispatcher.dispatch(new ContextClear({ agentId: 'main' }));
    await flushed();
    expect(h.events).toEqual([{ type: 'turns.removed', turn_ids: [first] }]);
    expect((await h.feed.page(undefined, 20)).turns).toEqual([]);
    h.dispatcher.dispose();
  });

  it('refuses to undo an unknown turn or a turn that does not open with user input', async () => {
    const h = feedHarness([
      prompt(0, 'p1').serialize(),
      new ContextAppendMessage({
        agentId: 'main',
        message: { role: 'user', id: 'g1', content: [{ type: 'text', text: 'continue' }], origin: { kind: 'system_trigger', name: 'goal_continuation' } },
      }).serialize(),
      new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }).serialize(),
    ]);
    await h.dispatcher.restore();
    await h.feed.ready;
    const [goal] = h.feed.turns();

    await expect(h.feed.undo('t_missing')).rejects.toMatchObject({ code: 'turn.not_found' });
    await expect(h.feed.undo(goal!.turn_id)).rejects.toMatchObject({ code: 'session.undo_unavailable' });
    h.dispatcher.dispose();
  });

  it('announces a turn before the live items streamed into it and streams text as deltas of its field', async () => {
    const h = feedHarness([]);
    await h.dispatcher.restore();
    await h.feed.ready;

    void h.dispatcher.dispatch(prompt(0, 'p1'));
    void h.dispatcher.dispatch(userPrompt('p1', 'stream'));
    void h.dispatcher.dispatch(loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }));
    void h.dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 0, block: 0, delta: 'hi' }));
    void h.dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 0, block: 0, delta: ' there' }));

    expect(h.events.map((event) => ('item' in event ? `${event.type}:${event.item.item_id}` : event.type))).toEqual([
      'turn.started',
      'item.ended:p1',
      'item.started:s1:0',
      'item.delta',
    ]);
    expect(h.events[3]).toMatchObject({ type: 'item.delta', item_id: 's1:0', field: 'text', delta: ' there' });
    h.dispatcher.dispose();
  });

  it('ends a streamed item once, from the recorded step, with the duration the engine measured', async () => {
    const h = feedHarness([]);
    await runningTurn(h);

    await h.dispatcher.dispatch(new ThinkingDelta({ agentId: 'main', turnId: 0, block: 0, delta: 'plan' }));
    await h.dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 0, block: 1, delta: 'answer' }));
    await flushed();
    expect(h.events.map((event) => event.type)).toEqual(['item.started', 'item.started']);

    await h.dispatcher.dispatch(loopEvent({ type: 'content.part', turnId: '0', step: 1, stepUuid: 's1', block: 0, part: { type: 'think', think: 'plan' }, startedAt: 1_000, durationMs: 1_500 }));
    await h.dispatcher.dispatch(loopEvent({ type: 'content.part', turnId: '0', step: 1, stepUuid: 's1', block: 1, part: { type: 'text', text: 'answer' } }));
    await flushed();

    const ended = h.events.flatMap((event) => (event.type === 'item.ended' && 'item' in event ? [event.item] : []));
    expect(ended.map((item) => item.item_id)).toEqual(['s1:0', 's1:1']);
    expect(ended[0]).toMatchObject({ type: 'reasoning', duration_ms: 1_500 });
    h.dispatcher.dispose();
  });

  it('removes the reply a failed attempt streamed once a retry of its step begins', async () => {
    const h = feedHarness([]);
    await runningTurn(h);

    await h.dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 0, block: 0, delta: 'Affected: eu-west ' }));
    await h.dispatcher.dispatch(loopEvent({ type: 'content.part', turnId: '0', step: 1, stepUuid: 's1', block: 0, part: { type: 'text', text: 'Affected: eu-west ' } }));
    await h.dispatcher.dispatch(loopEvent({ type: 'step.end', uuid: 's1', turnId: '0', step: 1, finishReason: 'error' }));
    await h.dispatcher.dispatch(loopEvent({ type: 'step.begin', uuid: 's2', turnId: '0', step: 1 }));
    await h.dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 0, block: 0, delta: 'Affected regions are eu-west and us-east.' }));
    await flushed();

    expect(h.events.flatMap((event) => {
      if (event.type === 'item.started' || event.type === 'item.ended') return [`${event.type}:${event.item.item_id}`];
      return event.type === 'item.removed' ? [`${event.type}:${event.item_id}`] : [];
    })).toEqual(['item.started:s1:0', 'item.ended:s1:0', 'item.removed:s1:0', 'item.started:s2:0']);
    expect((await h.feed.page(undefined, 20)).turns[0]?.items.map((item) => item.item_id)).toEqual(['p1', 's2:0']);
    h.dispatcher.dispose();
  });

  it('announces the task a running tool call starts', async () => {
    const h = feedHarness([]);
    await runningTurn(h);
    await h.dispatcher.dispatch(loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'call-1', name: 'Bash', args: { command: 'npm test' }, turnId: '0', step: 1 }));
    await flushed();
    const info = { kind: 'process', taskId: 'bash-p81', parentToolCallId: 'call-1' } as unknown as AgentTaskInfo;
    await h.dispatcher.dispatch(new TaskStarted({ agentId: 'main', info }));
    await flushed();

    expect(h.events.at(-1)).toMatchObject({ type: 'item.updated', item_id: 'call-1', set: { task_id: 'bash-p81' } });
  });

  it('streams a tool call through its stages, input, output and fields', async () => {
    const h = feedHarness([]);
    await runningTurn(h);

    const display = { kind: 'command', command: 'ls' } as const;
    await h.dispatcher.dispatch(new ToolCallDelta({ agentId: 'main', turnId: 0, toolCallId: 'call-1', name: 'Bash', argumentsPart: '{"command":' }));
    await h.dispatcher.dispatch(new ToolCallDelta({ agentId: 'main', turnId: 0, toolCallId: 'call-1', argumentsPart: '"ls"}' }));
    await h.dispatcher.dispatch(new InteractionRequestEvent({
      agentId: 'main',
      id: 'i1',
      kind: 'approval',
      toolCallId: 'call-1',
      request: { toolCallId: 'call-1', toolName: 'Bash', action: 'run', display, turnId: 0 },
    }));
    await flushed();
    await h.dispatcher.dispatch(new InteractionResolvedEvent({ agentId: 'main', id: 'i1', response: { decision: 'approved' } }));
    await flushed();
    await h.dispatcher.dispatch(loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'call-1', name: 'Bash', args: { command: 'ls' }, display, turnId: '0', step: 1 }));
    await flushed();
    await h.dispatcher.dispatch(updated({}, { offset: 0, text: 'a\n' }));
    await h.dispatcher.dispatch(updated({}, { offset: 0, text: 'a\n' }));
    await h.dispatcher.dispatch(updated({}, { offset: 2, text: 'b\n' }));
    await h.dispatcher.dispatch(updated({ progress: { percent: 40, text: 'copying' } }));
    await h.dispatcher.dispatch(updated({ progress: { percent: 40, text: 'copying' }, status: 'verifying' }));
    await h.dispatcher.dispatch(updated({ progress: { percent: 40, text: 'copying' }, status: 'verifying', 'example.kind': { url: 'https://example.com/auth' } }));
    const midway = (await h.feed.page(undefined, 20)).turns[0]?.items[1];

    const tool = { turn_id: expect.any(String), item_id: 'call-1' };
    expect(h.events).toMatchObject([
      { type: 'item.started', item: { item_id: 'call-1', type: 'tool_call', status: 'running', stage: 'input', name: 'Bash', input_text: '{"command":' } },
      { type: 'item.delta', ...tool, field: 'input_text', delta: '"ls"}' },
      { type: 'item.updated', ...tool, set: { stage: 'awaiting_approval', interaction_id: 'i1', display } },
      { type: 'item.updated', ...tool, set: { stage: 'executing' } },
      { type: 'item.updated', ...tool, set: { input: { command: 'ls' } } },
      { type: 'item.updated', ...tool, set: { fields: {} } },
      { type: 'item.delta', ...tool, field: 'output', delta: 'a\n' },
      { type: 'item.delta', ...tool, field: 'output', delta: 'b\n' },
      { type: 'item.updated', ...tool, set: { fields: { progress: { percent: 40, text: 'copying' } } } },
      { type: 'item.updated', ...tool, set: { fields: { progress: { percent: 40, text: 'copying' }, status: 'verifying' } } },
      { type: 'item.updated', ...tool, set: { fields: { progress: { percent: 40, text: 'copying' }, status: 'verifying', 'example.kind': { url: 'https://example.com/auth' } } } },
    ]);
    expect(Object.keys((h.events[3] as { set: object }).set)).toEqual(['stage']);
    expect(Object.keys((h.events[4] as { set: object }).set)).toEqual(['input']);
    expect(midway).toMatchObject({
      stage: 'executing',
      output: 'a\nb\n',
      fields: { status: 'verifying', 'example.kind': { url: 'https://example.com/auth' } },
    });

    await h.dispatcher.dispatch(loopEvent({ type: 'tool.result', toolCallId: 'call-1', result: { output: 'done' } }));
    await flushed();
    const ended = (h.events.at(-1) as { item: ConversationItem }).item;
    expect(ended).toMatchObject({ type: 'tool_call', status: 'ended', outcome: 'completed', output: 'done', interaction_id: 'i1' });
    expect(ended).not.toHaveProperty('stage', expect.anything());
    expect(ended).not.toHaveProperty('fields', expect.anything());

    const replayed = feedHarness([
      prompt(0, 'p1').serialize(),
      userPrompt('p1', 'run it').serialize(),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }).serialize(),
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'call-1', name: 'Bash', args: { command: 'ls' }, display, turnId: '0', step: 1 }).serialize(),
      loopEvent({ type: 'tool.result', toolCallId: 'call-1', result: { output: 'done' } }).serialize(),
      new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }).serialize(),
    ]);
    await replayed.dispatcher.restore();
    await replayed.feed.ready;
    const reloaded = (await replayed.feed.page(undefined, 20)).turns[0]?.items.find((item) => item.item_id === 'call-1');
    expect(reloaded).toMatchObject({ status: 'ended', output: 'done' });
    expect(reloaded).not.toHaveProperty('fields');
    expect(replayed.events.filter((event) => event.type === 'item.delta' && event.field === 'output')).toEqual([]);
    replayed.dispatcher.dispose();
    h.dispatcher.dispose();
  });

  it('keeps a page within 1 MiB by dropping its oldest turns and always keeps the newest turn', async () => {
    const turnRecords = (turnId: number, text: string): WireRecord[] => [
      prompt(turnId, `p${turnId}`).serialize(),
      userPrompt(`p${turnId}`, text).serialize(),
      new TurnEnded({ agentId: 'main', turnId, reason: 'completed' }).serialize(),
    ];
    const large = feedHarness([0, 1, 2].flatMap((turnId) => turnRecords(turnId, `${turnId}:${'x'.repeat(400 * 1024)}`)));
    await large.dispatcher.restore();
    await large.feed.ready;

    const page = await large.feed.page(undefined, 10);
    expect(page.turns.map((turn) => turn.ordinal)).toEqual([1, 2]);
    expect(page.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024);
    large.dispatcher.dispose();

    const huge = feedHarness(turnRecords(0, 'y'.repeat(1200 * 1024)));
    await huge.dispatcher.restore();
    await huge.feed.ready;
    expect(await huge.feed.page(undefined, 10)).toMatchObject({ turns: [{ ordinal: 0 }], has_more: false });
    huge.dispatcher.dispose();
  });
});
