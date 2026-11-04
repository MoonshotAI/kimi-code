import {
  CompactionCancelled,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
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
import {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
  ContextUndo,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { AssistantDelta, ToolCallDelta, TurnStepRetrying } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt, TurnSteer } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { AgentErrorEvent } from '@moonshot-ai/agent-core-v2/agent/mcp/mcpEvents';
import { WarningIssued } from '@moonshot-ai/agent-core-v2/agent/profile/profileOps';
import { AgentStateService } from '@moonshot-ai/agent-core-v2/agent/state/agentStateService';
import { ToolProgress } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import { EventBusService } from '@moonshot-ai/agent-core-v2/app/event/eventBusService';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';
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
import { mediaPartsOf, presentTurn } from '../../src/services/conversation/conversationProjection';
import { parseWireRecords } from '../../src/services/conversation/conversationService';
import { parseTaskNotifications } from '../../src/services/conversation/taskNotifications';

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

function fold(records: readonly WireRecord[], fork?: ConversationFork): ConversationState {
  const state = createConversationState('main', fork);
  for (const entry of records) applyConversationRecord(state, entry);
  return state;
}

function turnsOf(state: ConversationState): ConversationTurn[] {
  return state.turns.map((turn) => presentTurn(turn, turn.items));
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
      stepBegin(0, 2, 's2'),
      stepEnd(0, 2, 's2', { finishReason: 'end_turn', usage: { inputOther: 5, output: 1, inputCacheRead: 4, inputCacheCreation: 0 } }),
      turnEnded(0, 'completed', { durationMs: 120 }),
    ]);

    const [turn] = turnsOf(state);
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
        timing: { first_token_ms: 40, server_decode_ms: 7 },
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

  it('shows only ended steps and their outcomes from step ends and step interruptions', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'work'),
      stepBegin(0, 1, 's1'),
      stepEnd(0, 1, 's1', { finishReason: 'error' }),
      stepBegin(0, 2, 's2'),
      stepEnd(0, 2, 's2', { finishReason: 'interrupted' }),
      record('turn.step.interrupted', { turnId: 0, step: 2, reason: 'aborted' }),
      stepBegin(0, 3, 's3'),
    ]);

    expect(turnsOf(state)[0]?.steps.map((step) => `${step.index}:${step.outcome}`)).toEqual(['1:failed', '2:interrupted']);
    expect(turnsOf(state)[0]?.usage).toBeUndefined();
  });

  it('numbers block-less content parts by their position in the step', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'hello'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'think', think: 'a' }),
      contentPart(0, 1, 's1', { type: 'text', text: 'b' }),
    ]);

    expect(turnsOf(state)[0]?.items.map((item) => item.item_id)).toEqual(['p1', 's1:0', 's1:1']);
    expect(turnsOf(state)[0]?.status).toBe('running');
  });

  it('keeps the visible text, skills and client metadata of a user message and no server paths', () => {
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
          ],
          toolCalls: [],
        },
      }),
    ]);

    const opener = turnsOf(state)[0]?.items[0];
    expect(opener).toMatchObject({
      type: 'user_message',
      origin: { kind: 'user' },
      text: 'check this diff\nsecond line',
      skills: [{ name: 'review', args: '--deep' }],
      client_metadata: { display_text: 'check this diff' },
    });
    expect(JSON.stringify(opener)).not.toContain('/home/example');
  });

  it('lists media of the visible content as attachments in order', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      record('context.append_message', {
        message: {
          role: 'user',
          id: 'p1',
          origin: { kind: 'user' },
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', imageUrl: { url: 'kimi-file://f_example', id: 'f_example', name: 'shot.png' } },
            { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
            { type: 'video_url', videoUrl: { url: 'https://example.com/clip.mp4', name: 'clip.mp4' } },
            { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,BBBB' } },
          ],
          toolCalls: [],
        },
      }),
    ]);

    expect(turnsOf(state)[0]?.items[0]).toMatchObject({
      text: 'look',
      attachments: [
        { kind: 'image', file_id: 'f_example', name: 'shot.png', ordinal: 1 },
        { kind: 'image', url: 'data:image/png;base64,AAAA', media_type: 'image/png', ordinal: 2 },
        { kind: 'video', url: 'https://example.com/clip.mp4', name: 'clip.mp4', ordinal: 3 },
        { kind: 'audio', url: 'data:audio/wav;base64,BBBB', media_type: 'audio/wav', ordinal: 4 },
      ],
    });
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
      userMessage('cron-1', 'nightly report', {
        kind: 'cron_job',
        jobId: 'job-1',
        cron: '0 3 * * *',
        recurring: true,
        coalescedCount: 2,
        stale: false,
      }),
      turnPrompt(3, 'missed', { kind: 'cron_missed' }),
      userMessage('missed', 'missed runs', { kind: 'cron_missed', count: 2 }),
      turnPrompt(4, 'hook-1', { kind: 'hook_result' }),
      userMessage('hook-1', 'hook output', { kind: 'hook_result', event: 'SessionStart' }),
    ]);

    const openers = turnsOf(state).map((turn) => turn.items[0]);
    expect(openers.map((item) => (item?.type === 'user_message' ? [item.origin, item.prompt_ids, item.text] : []))).toEqual([
      [{ kind: 'skill', name: 'commit', args: '-m wip' }, ['k1'], 'User activated the skill'],
      [{ kind: 'plugin_command', plugin_id: 'example-plugin', command: 'deploy', args: 'staging' }, ['c1'], 'Plugin command'],
      [{ kind: 'retry' }, [], ''],
      [{ kind: 'goal' }, [], ''],
      [{ kind: 'system' }, [], 'Report back to the parent agent'],
      [{ kind: 'cron', job_id: 'job-1', schedule: '0 3 * * *', recurring: true, coalesced_count: 2, stale: false }, [], 'nightly report'],
      [{ kind: 'system' }, [], 'missed runs'],
      [{ kind: 'hook', hook_event: 'SessionStart' }, [], 'hook output'],
    ]);
  });

  it('hides CLI shell commands and injections', () => {
    const state = fold([
      userMessage(undefined, '<bash-input>\nls\n</bash-input>', { kind: 'shell_command', phase: 'input' }),
      userMessage(undefined, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>', { kind: 'shell_command', phase: 'output' }),
      userMessage(undefined, '<system-reminder>', { kind: 'injection', variant: 'example' }),
    ]);

    expect(state.turns).toEqual([]);
    expect(state.openTurnId).toBeUndefined();
  });

  it('ends a running tool call without a result as interrupted and settles its interaction', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'run it'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'call-1', 'Bash', { command: 'ls' }),
      record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'call-1', request: {} }),
      toolCall(0, 1, 's1', 'call-2', 'Read', { path: 'a.ts' }),
      toolResult('call-2', 'boom', true),
      turnEnded(0, 'cancelled'),
    ]);

    const [turn] = turnsOf(state);
    expect(turn).toMatchObject({ outcome: 'interrupted', end_reason: 'user_cancelled' });
    expect(turn?.items[1]).toMatchObject({ type: 'tool_call', status: 'ended', outcome: 'interrupted', interaction_id: 'i1' });
    expect(turn?.items[1]).not.toHaveProperty('stage', expect.anything());
    expect(turn?.items[2]).toMatchObject({ type: 'tool_call', status: 'ended', outcome: 'failed', error: 'boom' });
    expect((turn?.items[2] as { output?: unknown }).output).toBeUndefined();
    expect(state.turns[0]?.items[1]).toMatchObject({ interaction: { pending: false } });
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

    expect(turnsOf(state).map((turn) => `${turn.outcome}/${turn.end_reason ?? ''}/${turn.error?.code ?? ''}`)).toEqual([
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

  it('projects the error of a failed turn', () => {
    const state = fold([
      turnPrompt(1, 'p2'),
      userMessage('p2', 'fails'),
      turnEnded(1, 'failed', {
        requestId: 'req-1',
        error: { code: 'provider.rate_limit', message: 'slow down', name: 'RateLimitError', retryable: true, details: { statusCode: 429 } },
      }),
    ]);

    expect(turnsOf(state)[0]?.error).toEqual({
      code: 'provider.rate_limit',
      message: 'slow down',
      name: 'RateLimitError',
      retryable: true,
      status_code: 429,
      request_id: 'req-1',
    });
  });

  it('carries a request retry on the turn until the next step begins, a step ends or the turn ends', () => {
    const retrying = (failedAttempt: number): WireRecord =>
      record('turn.step.retrying', {
        turnId: 0,
        step: 1,
        failedAttempt,
        nextAttempt: failedAttempt + 1,
        maxAttempts: 3,
        delayMs: 1500.4,
        errorName: 'APITimeoutError',
        errorMessage: 'Request timed out.',
        statusCode: 504,
      });
    const state = fold([turnPrompt(0, 'p1'), userMessage('p1', 'work'), stepBegin(0, 1, 's1'), stepEnd(0, 1, 's1', { finishReason: 'error' }), retrying(1)]);

    expect(turnsOf(state)[0]?.retry).toEqual({
      attempt: 1,
      next_attempt: 2,
      max_attempts: 3,
      delay_ms: 1500,
      error: { name: 'APITimeoutError', message: 'Request timed out.', status_code: 504 },
    });
    applyConversationRecord(state, stepBegin(0, 2, 's2'));
    expect(turnsOf(state)[0]?.retry).toBeUndefined();
    applyConversationRecord(state, retrying(2));
    applyConversationRecord(state, stepEnd(0, 2, 's2'));
    expect(turnsOf(state)[0]?.retry).toBeUndefined();
    applyConversationRecord(state, retrying(2));
    applyConversationRecord(state, turnEnded(0, 'failed', { error: { code: 'provider.timeout', message: 'gave up' } }));
    expect(turnsOf(state)[0]).toMatchObject({ outcome: 'failed', end_reason: 'error' });
    expect(turnsOf(state)[0]?.retry).toBeUndefined();
  });

  it('gives turns ids that stay stable across a replay and differ after an undo reuses their ordinal', () => {
    const first = [turnPrompt(0, 'p1'), userMessage('p1', 'first'), turnEnded(0, 'completed')];
    const original = turnsOf(fold(first))[0]!;
    expect(turnsOf(fold(first))[0]?.turn_id).toBe(original.turn_id);

    const afterUndo = turnsOf(fold([turnPrompt(0, 'p2'), userMessage('p2', 'second'), turnEnded(0, 'completed')]))[0]!;
    expect(afterUndo.ordinal).toBe(original.ordinal);
    expect(afterUndo.turn_id).not.toBe(original.turn_id);

    const other = createConversationState('agent-other');
    for (const entry of first) applyConversationRecord(other, entry);
    expect(turnsOf(other)[0]?.turn_id).not.toBe(original.turn_id);
  });

  it('times reasoning by its streamed block and falls back to the step span for untimed records', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'hello'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'think', think: 'timed' }, 0, { startedAt: 5_000, durationMs: 1_200 }),
      contentPart(0, 1, 's1', { type: 'think', think: 'untimed' }, 1),
    ]);

    const stepStart = iso(state.turns[0]!.steps[0]!.startedAt);
    const turn = turnsOf(state)[0];
    expect(turn?.items[1]).toMatchObject({ type: 'reasoning', created_at: iso(5_000), started_at: iso(5_000), duration_ms: 1_200 });
    expect(turn?.items[2]).toMatchObject({ type: 'reasoning', started_at: stepStart, duration_ms: 2 });
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
    expect(shape(turnsOf(state)[0])).toEqual(['opener:first', 'steer:steer now', 'steer:legacy steer']);
    expect(turnsOf(state)[0]?.items[1]).toMatchObject({ prompt_ids: ['p2', 'p3'] });
  });

  it('keeps task notifications in the running turn and opens a turn for task prompts', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'work'),
      stepBegin(0, 1, 's1'),
      userMessage(undefined, notificationXml('a'), { kind: 'task', taskId: 'a' }),
      turnEnded(0, 'completed'),
      turnPrompt(1, undefined, { kind: 'task', taskId: 'b' }),
      userMessage(undefined, notificationXml('b'), { kind: 'task', taskId: 'b' }),
      stepBegin(1, 1, 's2'),
      turnEnded(1, 'completed'),
      userMessage('n-c', `${notificationXml('c')}\n\n${notificationXml('d')}`, { kind: 'task', taskId: 'c' }),
    ]);

    expect(turnsOf(state).map(shape)).toEqual([
      ['opener:work', 'notification:task:a:completed'],
      ['notification:task:b:completed'],
      ['notification:task:c:completed', 'notification:task:d:completed'],
    ]);
    expect(turnsOf(state)[1]).toMatchObject({ turn_number: 1, status: 'ended' });
    expect(turnsOf(state)[2]).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(turnsOf(state)[2]?.items.map((item) => item.item_id)).toEqual(['n-c', 'n-c:1']);
  });

  it('parses a task notification into protocol fields', () => {
    const state = fold([
      userMessage(
        'n1',
        '<notification id="task:agent-7:failed" category="task" type="task.failed" source_kind="background_task" source_id="agent-7" agent_id="agent-42">\n' +
          'Title: Background agent failed\nSeverity: warning\nExplore the codebase failed. Reason: exit code 1\n' +
          '<output-preview bytes="46" total_bytes="4096" truncated="true">\nShowing the last 46 bytes. No persisted full output is available.\n' +
          'tail &amp;&amp; done\n</output-preview>\n</notification>',
        { kind: 'task', taskId: 'agent-7' },
      ),
    ]);

    expect(turnsOf(state)[0]?.items[0]).toEqual({
      type: 'notification',
      item_id: 'n1',
      status: 'ended',
      outcome: 'completed',
      created_at: expect.any(String),
      notification_id: 'task:agent-7:failed',
      title: 'Background agent failed',
      body: 'Explore the codebase failed. Reason: exit code 1',
      severity: 'warning',
      notification_type: 'task.failed',
      source: { kind: 'background_task', id: 'agent-7' },
      task_id: 'agent-7',
      agent_id: 'agent-42',
      output: { preview: 'tail && done', bytes: 4096, truncated: true },
    });
  });

  it('opens turns for user-slash skills and goal continuations but not for model-loaded skills', () => {
    const state = fold([
      userMessage('k1', 'User activated the skill', { kind: 'skill_activation', trigger: 'user-slash' }),
      userMessage(undefined, 'loaded by the model', { kind: 'skill_activation', trigger: 'model-tool' }),
      userMessage(undefined, 'hidden reminder', { kind: 'system_trigger', name: 'other' }),
      userMessage(undefined, 'Continue working toward the active goal', { kind: 'system_trigger', name: 'goal_continuation' }),
    ]);

    expect(turnsOf(state).map(shape)).toEqual([['opener:User activated the skill'], ['opener:']]);
    expect(turnsOf(state)[1]?.items[0]).toMatchObject({ origin: { kind: 'goal' } });
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

    const items = turnsOf(state)[0]?.items ?? [];
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
    expect(state.pendingTools).toEqual({});
  });

  it('opens the tool call an approval waits for before the tool call is recorded', () => {
    const display = { kind: 'command', command: 'rm -rf dist' };
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'clean up'),
      stepBegin(0, 1, 's1'),
      record('interaction.request', {
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        request: { toolCallId: 'call-1', toolName: 'Bash', action: 'run', display, turnId: 0 },
      }),
    ]);
    const waiting = turnsOf(state)[0]?.items[1];
    expect(waiting).toMatchObject({ type: 'tool_call', item_id: 'call-1', name: 'Bash', step_index: 1, stage: 'awaiting_approval', interaction_id: 'i1', display });

    applyConversationRecord(state, record('interaction.resolved', { id: 'i1', response: { decision: 'approved' } }));
    applyConversationRecord(state, toolCall(0, 1, 's1', 'call-1', 'Bash', { command: 'rm -rf dist' }));
    applyConversationRecord(state, toolResult('call-1', ''));
    expect(turnsOf(state)[0]?.items).toHaveLength(2);
    expect(turnsOf(state)[0]?.items[1]).toMatchObject({
      status: 'ended',
      outcome: 'completed',
      input: { command: 'rm -rf dist' },
      display,
      interaction_id: 'i1',
      created_at: waiting?.created_at,
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
    expect(turnsOf(pending)[0]?.items[1]).toMatchObject({ stage: 'awaiting_approval', display: { review: { state: 'pending' } } });

    applyConversationRecord(pending, record('interaction.resolved', { id: 'i1', response: { decision: 'rejected', feedback: 'Cover the error path too.' } }));
    expect(turnsOf(pending)[0]?.items[1]).toMatchObject({
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
    expect(turnsOf(legacy)[0]?.items[1]).toMatchObject({
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

    const turns = turnsOf(state);
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

    const turns = turnsOf(state);
    expect(turns.map((turn) => `${turn.kind}:${turn.ordinal}`)).toEqual(['system:0', 'agent:1']);
    expect(turns[0]?.items).toEqual([expect.objectContaining({ type: 'system', kind: 'fork_boundary', source: 'btw', forked_from: { agent_id: 'main' } })]);
    expect(shape(turns[1])).toEqual(['opener:what does this do?']);
    expect(JSON.stringify(turns)).not.toContain('inherited');
  });

  it('ends a prompt a hook blocked as blocked and the hook result before it as completed', () => {
    const hookResult = (text: string): WireRecord =>
      message('assistant', text, { origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true } });
    const state = fold([
      hookResult('Blocked by policy'),
      userMessage('p1', 'do the thing'),
      record('prompt.completed', { promptId: 'p1', reason: 'blocked' }),
      hookResult('Blocked again'),
      record('prompt.completed', { promptId: 'p2', reason: 'blocked' }),
    ]);

    expect(turnsOf(state).map((turn) => `${shape(turn).join('|')}:${turn.status}:${turn.outcome}:${turn.end_reason ?? ''}`)).toEqual([
      'assistant_message:Blocked by policy:ended:completed:',
      'opener:do the thing:ended:failed:blocked',
      'assistant_message:Blocked again:ended:completed:',
    ]);
    expect(turnsOf(state)[0]?.items[0]?.item_id).toBe(`${state.turns[0]!.id}#0`);
  });

  it('drops the turn prompt of a turn that ended before anything opened it', () => {
    const injection = { kind: 'injection', variant: 'shell_command_backgrounded' };
    const state = fold([
      turnPrompt(3, 'p3', injection),
      userMessage('p3', 'task_id: bash-1', injection),
      turnEnded(3, 'failed'),
      message('assistant', 'Blocked by policy', { origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true } }),
      userMessage('p4', 'do the thing'),
      record('prompt.completed', { promptId: 'p4', reason: 'blocked' }),
    ]);

    expect(turnsOf(state).map((turn) => `${turn.turn_number}:${turn.status}:${turn.outcome}`)).toEqual([
      'undefined:ended:completed',
      'undefined:ended:failed',
    ]);
    expect(state.pendingPrompt).toBeUndefined();
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
    expect(state.openTurnId).toBe(state.turns[0]?.id);

    for (const entry of [contentPart(0, 1, 's1', { type: 'text', text: 'done' }, 0), stepEnd(0, 1, 's1'), turnEnded(0, 'completed')]) {
      applyConversationRecord(state, entry);
    }

    expect(turnsOf(state).map((turn) => `${turn.turn_number}:${turn.outcome}`)).toEqual([
      '0:completed',
      'undefined:completed',
      'undefined:completed',
    ]);
    expect(shape(turnsOf(state)[0])).toEqual(['opener:work', 'assistant_message:done']);
  });

  it('keeps the assistant run of an imported session in the turn its synthesized prompt opened', () => {
    const state = fold([
      turnPrompt(undefined, undefined, { kind: 'system_trigger', name: 'imported_orphan' }),
      message('assistant', 'carried over'),
      message('assistant', 'still the same turn'),
      turnEnded(0, 'completed'),
    ]);

    expect(state.turns).toHaveLength(1);
    expect(shape(turnsOf(state)[0])).toEqual(['assistant_message:carried over', 'assistant_message:still the same turn']);
    expect(turnsOf(state)[0]).toMatchObject({ turn_number: 0, status: 'ended', outcome: 'completed' });
  });

  it('drops a dangling turn prompt that does not match the next message', () => {
    const state = fold([
      turnPrompt(4, 'p-undone'),
      userMessage(undefined, notificationXml('t'), { kind: 'task', taskId: 't' }),
      turnPrompt(5, 'p5'),
      userMessage('p5', 'next'),
      stepBegin(5, 1, 's5'),
    ]);

    expect(turnsOf(state).map((turn) => turn.turn_number)).toEqual([undefined, 5]);
    expect(shape(turnsOf(state)[1])).toEqual(['opener:next']);
  });

  it('applies legacy undo records at message granularity', () => {
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
      record('context.undo', { count: 1 }),
      record('context.undo', { count: 1 }),
      turnPrompt(undefined, undefined),
      userMessage('d', 'third'),
    ]);

    expect(turnsOf(state).map(shape)).toEqual([
      ['opener:first', 'assistant_message:one'],
      ['opener:third'],
    ]);
  });

  it('cuts an undone steer and the steps that followed it from a turn that stays', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'first'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'text', text: 'one' }, 0),
      stepEnd(0, 1, 's1'),
      record('turn.steer', { input: [{ type: 'text', text: 'wait' }], origin: { kind: 'user' } }),
      userMessage('c', 'wait'),
      stepBegin(0, 2, 's2'),
      contentPart(0, 2, 's2', { type: 'text', text: 'two' }, 0),
      stepEnd(0, 2, 's2'),
      turnEnded(0, 'completed'),
    ]);

    const [turn] = undoConversationTurns(state, 1).turns;
    expect(shape(turn === undefined ? undefined : presentTurn(turn, turn.items))).toEqual(['opener:first', 'assistant_message:one']);
    expect(turn?.steps.map((step) => step.id)).toEqual(['s1']);
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

    expect(shape(turnsOf(state)[0])).toEqual(['opener:read it', 'reasoning:hmm', 'assistant_message:reading', 'tool:Read_0:ended']);
    expect(turnsOf(state)[0]?.items[3]).toMatchObject({ input: { path: 'a.ts' }, outcome: 'failed', error: 'file body' });
  });

  it('reattaches records of a turn that a later opener implicitly ended', () => {
    const state = fold([
      turnPrompt(undefined, undefined),
      userMessage('a', 'long task'),
      stepBegin(21, 1, 's21'),
      turnPrompt(undefined, undefined),
      userMessage('b', 'side question'),
      stepBegin(12, 1, 's12'),
      record('turn.cancel', { turnId: 12 }),
      turnEnded(12, 'cancelled'),
      contentPart(21, 1, 's21', { type: 'text', text: 'done' }),
      turnEnded(21, 'completed'),
    ]);

    expect(turnsOf(state).map((turn) => `${turn.turn_number}:${turn.outcome}`)).toEqual(['21:completed', '12:interrupted']);
    expect(shape(turnsOf(state)[0])).toEqual(['opener:long task', 'assistant_message:done']);
  });

  it('clears the conversation on context clear', () => {
    const state = fold([userMessage('a', 'one'), record('context.clear', {}), userMessage('b', 'two')]);

    expect(turnsOf(state).map(shape)).toEqual([['opener:two']]);
    expect(turnsOf(state)[0]?.ordinal).toBe(1);
  });
});

describe('orphan turns', () => {
  const unfinished = (): ConversationState => fold([
    turnPrompt(0, 'p1'),
    userMessage('p1', 'run it'),
    stepBegin(0, 1, 's1'),
    toolCall(0, 1, 's1', 'call-1', 'Bash', { command: 'ls' }),
    record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'call-1', request: {} }),
  ]);

  it('ends a running turn nothing runs anymore as aborted, with its items, without touching the input', () => {
    const state = unfinished();
    const before = structuredClone(state);

    const settled = settleOrphanTurns(state);

    expect(state).toEqual(before);
    expect(turnsOf(settled)[0]).toMatchObject({ status: 'ended', outcome: 'interrupted', end_reason: 'aborted', ended_at: iso(state.clock) });
    expect(turnsOf(settled)[0]?.items[1]).toMatchObject({ status: 'ended', outcome: 'interrupted', interaction_id: 'i1' });
    expect(settled.openTurnId).toBeUndefined();
  });

  it('keeps the turn the loop is running', () => {
    const state = unfinished();
    expect(settleOrphanTurns(state, { turnNumber: 0 })).toBe(state);
    expect(fold([record('full_compaction.begin', { source: 'manual' })]).turns).toEqual([]);
  });

  it('leaves an interrupted turn alone when the next prompt opens a turn', () => {
    const settled = settleOrphanTurns(unfinished());

    applyConversationRecord(settled, turnPrompt(1, 'p2'));
    applyConversationRecord(settled, userMessage('p2', 'next'));

    expect(turnsOf(settled).map((turn) => `${turn.turn_number}:${turn.status}:${turn.outcome ?? ''}`)).toEqual([
      '0:ended:interrupted',
      '1:running:',
    ]);
  });
});

describe('task notifications', () => {
  it('keeps the agent id, output file and surrounding prose and unescapes entities', () => {
    const [notification] = parseTaskNotifications(
      '<notification id="task:a&amp;b:completed" category="task" type="task.completed" source_kind="subagent" source_id="b" agent_id="agent-42">\n' +
        'Title: pnpm lint &amp;&amp; pnpm build\nSeverity: info\nline one\nline two\n' +
        '<output-file path="/tmp/o.log" bytes="3">\nread it\n</output-file>\n</notification>',
    );

    expect(notification).toEqual({
      id: 'task:a&b:completed',
      type: 'task.completed',
      sourceKind: 'subagent',
      sourceId: 'b',
      agentId: 'agent-42',
      title: 'pnpm lint && pnpm build',
      severity: 'info',
      body: 'line one\nline two',
      output: { file: '/tmp/o.log', preview: undefined, bytes: 3, truncated: undefined },
    });
  });

  it('ignores text without a well-formed block and runs in linear time on malformed input', () => {
    expect(parseTaskNotifications('plain user text')).toEqual([]);
    expect(parseTaskNotifications('<notification id="x">unclosed')).toEqual([]);
    expect(parseTaskNotifications('<notifications>x</notifications>')).toEqual([]);
    const started = performance.now();
    expect(parseTaskNotifications('<notification>'.repeat(20_000))).toEqual([]);
    expect(parseTaskNotifications(`<notification ${'a'.repeat(200_000)}></notification>`)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2_000);
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
  };
}

const prompt = (turnId: number, promptId: string): TurnPrompt =>
  new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' }, promptId, turnId });

const userPrompt = (id: string, text: string): ContextAppendMessage =>
  new ContextAppendMessage({ agentId: 'main', message: { role: 'user', id, content: [{ type: 'text', text }], origin: { kind: 'user' } } });

const loopEvent = (event: LoopRecordedEvent): ContextAppendLoopEvent => new ContextAppendLoopEvent({ agentId: 'main', event });

const progress = (update: ToolProgress['update']): ToolProgress =>
  new ToolProgress({ agentId: 'main', turnId: 0, toolCallId: 'call-1', update });

const flushed = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const turnSummary = (turn: ConversationTurn): string => `${turn.turn_number}:${turn.status}:${turn.outcome ?? ''}`;

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
  it('shows a restored turn that never ended as interrupted and keeps it so when the next prompt runs', async () => {
    const h = feedHarness([
      prompt(0, 'p1').serialize(),
      userPrompt('p1', 'run it').serialize(),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }).serialize(),
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'call-1', name: 'Bash', turnId: '0', step: 1 }).serialize(),
      new InteractionRequestEvent({ agentId: 'main', id: 'i1', kind: 'approval', toolCallId: 'call-1', request: {} }).serialize(),
    ]);
    await h.dispatcher.restore();
    await h.feed.ready;

    const [orphan] = (await h.feed.page(undefined, 20)).turns;
    expect(orphan).toMatchObject({ turn_number: 0, status: 'ended', outcome: 'interrupted', end_reason: 'aborted' });
    expect(orphan?.items[1]).toMatchObject({ type: 'tool_call', status: 'ended', outcome: 'interrupted', interaction_id: 'i1' });

    await h.dispatcher.dispatch(prompt(1, 'p2'));
    await h.dispatcher.dispatch(userPrompt('p2', 'next'));

    expect((await h.feed.page(undefined, 20)).turns.map(turnSummary)).toEqual(['0:ended:interrupted', '1:running:']);
    h.dispatcher.dispose();
  });

  it('rejects ready when the first replay fails', async () => {
    const h = feedHarness([prompt(0, 'p1').serialize()]);
    h.failNextReplay();
    const ready = expect(h.feed.ready).rejects.toThrow('agent main failed to restore its conversation');

    await expect(h.dispatcher.restore()).rejects.toThrow('wire read failed');

    await ready;
    h.dispatcher.dispose();
  });

  it('keeps streaming after a rerun restore that no undo completion follows, failed reruns included', async () => {
    const h = feedHarness([
      prompt(0, 'p1').serialize(),
      userPrompt('p1', 'first').serialize(),
      new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }).serialize(),
    ]);
    await h.dispatcher.restore();
    await h.feed.ready;
    const before = (await h.feed.page(undefined, 20)).turns.map((turn) => turn.turn_id);

    await h.dispatcher.restore();
    expect(h.events.map((event) => event.type)).toEqual(['reset']);
    expect((await h.feed.page(undefined, 20)).turns.map((turn) => turn.turn_id)).toEqual(before);
    await h.dispatcher.dispatch(prompt(1, 'p2'));
    await h.dispatcher.dispatch(userPrompt('p2', 'second'));
    await flushed();
    expect(h.events.map((event) => event.type)).toEqual(['reset', 'turn.started', 'item.ended']);

    h.failNextReplay();
    await expect(h.dispatcher.restore()).rejects.toThrow('wire read failed');
    h.events.length = 0;
    await h.dispatcher.dispatch(prompt(2, 'p3'));
    await h.dispatcher.dispatch(userPrompt('p3', 'third'));
    await flushed();
    expect(h.events.map((event) => event.type)).toEqual(['turn.started', 'item.ended']);
    h.dispatcher.dispose();
  });

  it('serves a page only once a rerun replay has rebuilt the conversation', async () => {
    const h = feedHarness([
      prompt(0, 'p1').serialize(),
      userPrompt('p1', 'first').serialize(),
      new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }).serialize(),
    ]);
    await h.dispatcher.restore();
    await h.feed.ready;

    const held = h.holdNextReplay();
    const rerun = h.dispatcher.restore();
    await held.reached;
    let served = false;
    const page = h.feed.page(undefined, 20).then((result) => {
      served = true;
      return result;
    });
    await flushed();
    expect(served).toBe(false);

    held.release();
    await rerun;
    expect((await page).turns.map(turnSummary)).toEqual(['0:ended:completed']);
    h.dispatcher.dispose();
  });

  it('resends the turns page instead of removing turns when the context is cleared', async () => {
    const h = feedHarness([]);
    await h.dispatcher.restore();
    await h.feed.ready;
    await h.dispatcher.dispatch(prompt(0, 'p1'));
    await h.dispatcher.dispatch(userPrompt('p1', 'before the clear'));
    await h.dispatcher.dispatch(new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }));
    await flushed();
    h.events.length = 0;

    await h.dispatcher.dispatch(new ContextClear({ agentId: 'main' }));
    await flushed();

    expect(h.events.map((event) => event.type)).toEqual(['reset']);
    expect((await h.feed.page(undefined, 20)).turns).toEqual([]);
    h.dispatcher.dispose();
  });

  it('resends the turns page when an undo cuts items from a turn that stays', async () => {
    const h = feedHarness([]);
    await runningTurn(h);
    await h.dispatcher.dispatch(new TurnSteer({ agentId: 'main', input: [{ type: 'text', text: 'wait' }], origin: { kind: 'user' } }));
    await h.dispatcher.dispatch(userPrompt('c', 'wait'));
    await flushed();
    expect((await h.feed.page(undefined, 20)).turns[0]?.items).toHaveLength(2);
    h.events.length = 0;

    await h.dispatcher.dispatch(new ContextUndo({ agentId: 'main', count: 1 }));
    await flushed();

    expect(h.events.map((event) => event.type)).toEqual(['reset']);
    expect((await h.feed.page(undefined, 20)).turns[0]?.items.map((item) => item.item_id)).toEqual(['p1']);
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

  it('reports each ended step and every retry change on the turn', async () => {
    const h = feedHarness([]);
    await runningTurn(h);

    await h.dispatcher.dispatch(loopEvent({ type: 'step.end', uuid: 's1', turnId: '0', step: 1, finishReason: 'error' }));
    await h.dispatcher.dispatch(new TurnStepRetrying({
      agentId: 'main',
      turnId: 0,
      step: 1,
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 500.4,
      errorName: 'APITimeoutError',
      errorMessage: 'Request timed out.',
    }));
    await flushed();
    await h.dispatcher.dispatch(loopEvent({ type: 'step.begin', uuid: 's2', turnId: '0', step: 2 }));
    await flushed();

    const turnId = (h.events[0] as { turn_id: string }).turn_id;
    expect(JSON.parse(JSON.stringify(h.events))).toEqual([
      { type: 'turn.updated', turn_id: turnId, step: expect.objectContaining({ index: 1, outcome: 'failed', finish_reason: 'error' }) },
      {
        type: 'turn.updated',
        turn_id: turnId,
        retry: { attempt: 1, next_attempt: 2, max_attempts: 3, delay_ms: 500, error: { name: 'APITimeoutError', message: 'Request timed out.' } },
      },
      { type: 'turn.updated', turn_id: turnId },
    ]);
    h.dispatcher.dispose();
  });

  it('streams a tool call through its stages, input, output and progress', async () => {
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
    await h.dispatcher.dispatch(progress({ kind: 'stdout', text: 'a\n' }));
    await h.dispatcher.dispatch(progress({ kind: 'stderr', text: 'b\n' }));
    await h.dispatcher.dispatch(progress({ kind: 'stdout', text: 'fresh', replace: true }));
    await h.dispatcher.dispatch(progress({ kind: 'progress', percent: 40, text: 'copying' }));
    await h.dispatcher.dispatch(progress({ kind: 'status', text: 'verifying' }));
    await h.dispatcher.dispatch(progress({ kind: 'custom', customKind: 'example.kind', customData: { url: 'https://example.com/auth' } }));
    const midway = (await h.feed.page(undefined, 20)).turns[0]?.items[1];
    await h.dispatcher.dispatch(loopEvent({ type: 'tool.result', toolCallId: 'call-1', result: { output: 'done' } }));
    await flushed();

    const tool = { turn_id: expect.any(String), item_id: 'call-1' };
    expect(h.events).toMatchObject([
      { type: 'item.started', item: { item_id: 'call-1', type: 'tool_call', status: 'running', stage: 'input', name: 'Bash', input_text: '{"command":' } },
      { type: 'item.delta', ...tool, field: 'input_text', delta: '"ls"}' },
      { type: 'item.updated', ...tool, set: { stage: 'awaiting_approval', interaction_id: 'i1', display } },
      { type: 'item.updated', ...tool, set: { stage: 'executing' } },
      { type: 'item.updated', ...tool, set: { input: { command: 'ls' } } },
      { type: 'item.delta', ...tool, field: 'output', delta: 'a\n' },
      { type: 'item.delta', ...tool, field: 'output', delta: 'b\n' },
      { type: 'item.updated', ...tool, set: { output: 'fresh' } },
      { type: 'item.updated', ...tool, set: { progress: { percent: 40, status: 'copying' } } },
      { type: 'item.updated', ...tool, set: { progress: { percent: 40, status: 'verifying' } } },
      { type: 'item.updated', ...tool, set: { progress: { percent: 40, status: 'verifying', custom_kind: 'example.kind', custom_data: { url: 'https://example.com/auth' } } } },
      { type: 'item.ended', turn_id: expect.any(String), item: { item_id: 'call-1', status: 'ended', outcome: 'completed', output: 'done', interaction_id: 'i1' } },
    ]);
    expect(Object.keys((h.events[3] as { set: object }).set)).toEqual(['stage']);
    expect(Object.keys((h.events[4] as { set: object }).set)).toEqual(['input']);
    expect(midway).toMatchObject({ stage: 'executing', output: 'fresh', progress: { status: 'verifying', custom_kind: 'example.kind' } });
    const ended = (h.events.at(-1) as { item: ConversationItem }).item;
    expect(ended).not.toHaveProperty('stage', expect.anything());
    expect(ended).not.toHaveProperty('progress', expect.anything());
    h.dispatcher.dispose();
  });

  it('sends plan review changes of a running tool as display updates', async () => {
    const h = feedHarness([]);
    await runningTurn(h);
    await h.dispatcher.dispatch(loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'call-1', name: 'ExitPlanMode', turnId: '0', step: 1 }));
    await flushed();
    h.events.length = 0;

    const display = { kind: 'plan_review', plan: '# Plan', options: [{ label: 'Go' }] };
    await h.dispatcher.dispatch(new InteractionRequestEvent({ agentId: 'main', id: 'i1', kind: 'approval', toolCallId: 'call-1', request: { display } }));
    await flushed();
    await h.dispatcher.dispatch(new InteractionResolvedEvent({ agentId: 'main', id: 'i1', response: { decision: 'approved', selectedLabel: 'Go' } }));
    await flushed();

    expect(h.events).toMatchObject([
      { type: 'item.updated', set: { stage: 'awaiting_approval', interaction_id: 'i1', display: { kind: 'plan_review', review: { state: 'pending' } } } },
      { type: 'item.updated', set: { stage: 'executing', display: { review: { state: 'approved', selected_option: 'Go' } } } },
    ]);
    h.dispatcher.dispose();
  });

  it('sends a completed compaction as a system turn back to back and a cancelled one only as a notice', async () => {
    const h = feedHarness([]);
    await h.dispatcher.restore();
    await h.feed.ready;

    await h.dispatcher.dispatch(new FullCompactionBegin({ agentId: 'main', source: 'manual', instruction: 'keep notes' }));
    await h.dispatcher.dispatch(new ContextApplyCompaction({ agentId: 'main', summary: 'short', compactedCount: 4, tokensBefore: 100, tokensAfter: 10 }));
    await h.dispatcher.dispatch(new FullCompactionComplete({ agentId: 'main' }));
    await flushed();
    expect(h.events.map((event) => event.type)).toEqual(['turn.started', 'item.ended', 'turn.ended']);
    expect(h.events[1]).toMatchObject({ item: { type: 'system', kind: 'compaction', trigger: 'manual', instruction: 'keep notes', summary: 'short' } });
    expect(h.events[2]).toMatchObject({ turn: { kind: 'system', status: 'ended', outcome: 'completed' } });

    h.events.length = 0;
    await h.dispatcher.dispatch(new FullCompactionBegin({ agentId: 'main', source: 'auto' }));
    await h.dispatcher.dispatch(new FullCompactionCancel({ agentId: 'main' }));
    await h.dispatcher.dispatch(new CompactionCancelled({ agentId: 'main' }));
    await flushed();
    expect(h.events).toEqual([{ type: 'notice', level: 'warning', title: 'Context compaction did not finish', code: 'compaction.cancelled' }]);
    expect((await h.feed.page(undefined, 20)).turns).toHaveLength(1);
    h.dispatcher.dispose();
  });

  it('sends warnings and agent errors as notices', async () => {
    const h = feedHarness([]);
    await h.dispatcher.restore();
    await h.feed.ready;

    await h.dispatcher.dispatch(new WarningIssued({ agentId: 'main', message: 'MCP server example is slow', code: 'mcp.slow' }));
    await h.dispatcher.dispatch(new AgentErrorEvent({ agentId: 'main', code: 'provider.rate_limit', message: 'slow down', retryable: true, details: { statusCode: 429 } }));

    expect(h.events).toEqual([
      { type: 'notice', level: 'warning', title: 'MCP server example is slow', code: 'mcp.slow' },
      { type: 'notice', level: 'error', title: 'slow down', code: 'provider.rate_limit', detail: JSON.stringify({ retryable: true, details: { statusCode: 429 } }, null, 2) },
    ]);
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

  it('serves the stored reference of media that fails to load instead of failing the page', async () => {
    const blobs = {
      ...passThroughBlobs,
      loadParts: async (parts: readonly ContentPart[]) => {
        const [part] = parts;
        if (part?.type === 'image_url' && part.imageUrl.url.endsWith(';broken')) throw new Error('blob store offline');
        return parts.map(() => ({ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } }));
      },
    } as unknown as IAgentBlobService;
    const h = feedHarness([
      prompt(0, 'p1').serialize(),
      userPrompt('p1', 'look').serialize(),
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }).serialize(),
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'call-1', name: 'ReadMediaFile', turnId: '0', step: 1 }).serialize(),
      loopEvent({
        type: 'tool.result',
        toolCallId: 'call-1',
        result: {
          output: [
            { type: 'text', text: 'two images' },
            { type: 'image_url', imageUrl: { url: 'blobref:image/png;stored' } },
            { type: 'image_url', imageUrl: { url: 'blobref:image/png;broken' } },
          ],
        },
      }).serialize(),
      new TurnEnded({ agentId: 'main', turnId: 0, reason: 'completed' }).serialize(),
    ], blobs);
    await h.dispatcher.restore();
    await h.feed.ready;

    const [turn] = (await h.feed.page(undefined, 20)).turns;

    expect(turn?.items[1]).toMatchObject({
      type: 'tool_call',
      output: 'two images',
      media: [
        { kind: 'image', url: 'data:image/png;base64,AAAA', media_type: 'image/png' },
        { kind: 'image', url: 'blobref:image/png;broken' },
      ],
    });
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.dispatcher.dispose();
  });
});

describe('blob-backed media', () => {
  it('finds media of user content and of successful tool results', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      record('context.append_message', {
        message: { role: 'user', id: 'p1', origin: { kind: 'user' }, content: [{ type: 'video_url', videoUrl: { url: 'blobref:b' } }], toolCalls: [] },
      }),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'call-1', 'ReadMediaFile'),
      toolResult('call-1', [{ type: 'audio_url', audioUrl: { url: 'blobref:c' } }]),
      toolCall(0, 1, 's1', 'call-2', 'ReadMediaFile'),
      toolResult('call-2', [{ type: 'image_url', imageUrl: { url: 'blobref:d' } }], true),
    ]);

    expect(state.turns[0]!.items.map((item) => mediaPartsOf(item).length)).toEqual([1, 1, 0]);
  });
});

describe('cold wire records', () => {
  it('rejects a corrupted complete line and tolerates a torn last line', () => {
    const line = JSON.stringify({ type: 'context.clear', time: 1 });

    expect(parseWireRecords(`${line}\n{"type":"conte`, 'example/wire.jsonl')).toEqual([JSON.parse(line)]);
    expect(() => parseWireRecords(`${line}\n{"type":"conte\n${line}\n`, 'example/wire.jsonl')).toThrow(
      'wire.jsonl: corrupted line 2 in example/wire.jsonl',
    );
  });
});
