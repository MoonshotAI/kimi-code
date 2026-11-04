import {
  IAgentBlobService,
  IAgentFullCompactionService,
  IAgentLoopService,
  IEventBus,
  IEventDispatcher,
  ILogService,
  InteractionRequestEvent,
  makeAgentScopeContext,
  type IAgentScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import type { CollectionView } from '@moonshot-ai/agent-core-v2/_base/di/collection';
import { ContextAppendLoopEvent, ContextAppendMessage } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { AssistantDelta } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { AgentStateService } from '@moonshot-ai/agent-core-v2/agent/state/agentStateService';
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
  type ConversationState,
} from '../../src/services/conversation/conversationFold';
import {
  ConversationFeed,
  hasBlobRef,
  type ConversationEvent,
} from '../../src/services/conversation/conversationFeed';
import { parseWireRecords } from '../../src/services/conversation/conversationService';

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

function fold(records: readonly WireRecord[]): ConversationState {
  const state = createConversationState();
  for (const entry of records) applyConversationRecord(state, entry);
  return state;
}

function shape(turn: ConversationTurn | undefined): string[] {
  return (turn?.items ?? []).map((item) => {
    switch (item.type) {
      case 'user_message':
        return `${item.placement}:${item.content.map((part) => (part.type === 'text' ? part.text : part.type)).join('')}`;
      case 'assistant_message':
      case 'reasoning':
        return `${item.type}:${item.item_id}:${item.text}`;
      case 'tool_call':
        return `tool:${item.item_id}:${item.status}`;
      case 'notification':
        return `notification:${item.text}`;
      case 'compaction':
        return `compaction:${item.status}:${item.outcome ?? ''}`;
      default:
        return 'unknown';
    }
  });
}

describe('conversation fold', () => {
  it('folds a turn into ordered items keyed by step and block', () => {
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
      stepEnd(0, 1, 's1', { finishReason: 'tool_use', usage: { inputOther: 3, output: 2 }, llmFirstTokenLatencyMs: 40 }),
      turnEnded(0, 'completed', { durationMs: 120 }),
    ]);

    const [turn] = state.turns;
    expect(turn).toMatchObject({
      turn_id: 't0',
      ordinal: 0,
      turn_number: 0,
      kind: 'agent',
      status: 'ended',
      outcome: 'completed',
      duration_ms: 120,
      steps: [{ step_id: 's1', index: 1, finish_reason: 'tool_use', usage: { inputOther: 3, output: 2 }, llm_timing: { llmFirstTokenLatencyMs: 40 } }],
    });
    expect(shape(turn)).toEqual([
      'opener:hello',
      'reasoning:s1:0:plan',
      'assistant_message:s1:2:answer',
      'tool:call-1:ended',
    ]);
    expect(turn?.items[0]).toMatchObject({ item_id: 'p1', prompt_ids: ['p1'], origin: { kind: 'user' } });
    expect(turn?.items[3]).toMatchObject({ name: 'Bash', input: { command: 'ls' }, output: 'a\nb', duration_ms: 5 });
  });

  it('numbers block-less content parts by their position in the step', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'hello'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'think', think: 'a' }),
      contentPart(0, 1, 's1', { type: 'text', text: 'b' }),
    ]);

    expect(shape(state.turns[0])).toEqual(['opener:hello', 'reasoning:s1:0:a', 'assistant_message:s1:1:b']);
    expect(state.turns[0]?.status).toBe('running');
  });

  it('drops bundled skill instructions from user content and server paths from its origin', () => {
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
          ],
          toolCalls: [],
        },
      }),
    ]);

    expect(shape(state.turns[0])).toEqual(['opener:check this diff']);
    expect(state.turns[0]?.items[0]).toMatchObject({ type: 'user_message' });
    expect((state.turns[0]?.items[0] as { origin?: unknown }).origin).toEqual({
      kind: 'user',
      clientMetadata: [{ display_text: 'check this diff' }],
      skillActivations: [{ skillName: 'review', skillArgs: '--deep' }],
    });
  });

  it('hides the text of retries and internal triggers and keeps only display fields of their origins', () => {
    const state = fold([
      userMessage('k1', 'User activated the skill', {
        kind: 'skill_activation',
        trigger: 'user-slash',
        activationId: 'act-2',
        skillName: 'commit',
        skillPath: '/home/example/skills/commit',
      }),
      turnPrompt(1, 'p2', { kind: 'retry', trigger: 'provider_error' }),
      userMessage('p2', 'retry the previous request', { kind: 'retry', trigger: 'provider_error' }),
      userMessage(undefined, 'Continue working toward the active goal', { kind: 'system_trigger', name: 'goal_continuation' }),
      userMessage(undefined, 'Report back to the parent agent', { kind: 'system_trigger', name: 'subagent' }),
    ]);

    expect(state.turns.map(shape)).toEqual([
      ['opener:User activated the skill'],
      ['opener:'],
      ['opener:'],
      ['opener:Report back to the parent agent'],
    ]);
    expect((state.turns[0]?.items[0] as { origin?: unknown }).origin).toEqual({
      kind: 'skill_activation',
      trigger: 'user-slash',
      skillName: 'commit',
    });
    expect((state.turns[2]?.items[0] as { origin?: unknown }).origin).toEqual({ kind: 'system_trigger', name: 'goal_continuation' });
  });

  it('ends interactions left pending when their turn ends', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'run it'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'call-1', 'Bash', { command: 'ls' }),
      record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'call-1', request: {} }),
      turnEnded(0, 'cancelled'),
    ]);

    expect(state.turns[0]?.items[1]).toMatchObject({
      type: 'tool_call',
      status: 'ended',
      interaction: { interaction_id: 'i1', status: 'ended' },
    });
  });

  it('times reasoning by its streamed block and falls back to the step span for untimed records', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'hello'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'think', think: 'timed' }, 0, { startedAt: 5_000, durationMs: 1_200 }),
      contentPart(0, 1, 's1', { type: 'think', think: 'untimed' }, 1),
    ]);

    const turn = state.turns[0];
    const stepStart = turn?.steps[0]?.started_at;
    expect(turn?.items[1]).toMatchObject({ type: 'reasoning', started_at: new Date(5_000).toISOString(), duration_ms: 1_200 });
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
    expect(shape(state.turns[0])).toEqual(['opener:first', 'steer:steer now', 'steer:legacy steer']);
    expect(state.turns[0]?.items[1]).toMatchObject({ prompt_ids: ['p2', 'p3'] });
  });

  it('keeps task notifications in the running turn and opens a turn for task prompts', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'work'),
      stepBegin(0, 1, 's1'),
      userMessage(undefined, '<notification id="a"/>', { kind: 'task', taskId: 'a' }),
      turnEnded(0, 'completed'),
      turnPrompt(1, undefined, { kind: 'task', taskId: 'b' }),
      userMessage(undefined, '<notification id="b"/>', { kind: 'task', taskId: 'b' }),
      stepBegin(1, 1, 's2'),
      turnEnded(1, 'completed'),
      userMessage(undefined, '<notification id="c"/>', { kind: 'task', taskId: 'c' }),
    ]);

    expect(state.turns.map(shape)).toEqual([
      ['opener:work', 'notification:<notification id="a"/>'],
      ['notification:<notification id="b"/>'],
      ['notification:<notification id="c"/>'],
    ]);
    expect(state.turns[1]).toMatchObject({ turn_number: 1, status: 'ended' });
    expect(state.turns[2]).toMatchObject({ status: 'ended', outcome: 'completed' });
  });

  it('opens turns for user-slash skills and goal continuations but not for model-loaded skills', () => {
    const state = fold([
      userMessage('k1', 'User activated the skill', { kind: 'skill_activation', trigger: 'user-slash' }),
      userMessage(undefined, 'loaded by the model', { kind: 'skill_activation', trigger: 'model-tool' }),
      userMessage(undefined, 'hidden reminder', { kind: 'system_trigger', name: 'other' }),
      userMessage(undefined, 'Continue working toward the active goal', { kind: 'system_trigger', name: 'goal_continuation' }),
    ]);

    expect(state.turns.map(shape)).toEqual([
      ['opener:User activated the skill'],
      ['opener:'],
    ]);
    expect(state.turns[1]?.items[0]).toMatchObject({ origin: { kind: 'system_trigger', name: 'goal_continuation' } });
  });

  it('attaches interactions recorded before the tool call and subagent links to tool items', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'plan it'),
      stepBegin(0, 1, 's1'),
      record('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'call-1', request: { display: { kind: 'plan_review', plan: '# Plan' } } }),
      record('interaction.resolved', { id: 'i1', response: { decision: 'approved', selectedLabel: 'Go' } }),
      toolCall(0, 1, 's1', 'call-1', 'ExitPlanMode'),
      toolCall(0, 1, 's1', 'call-2', 'Agent'),
      record('subagent.spawned', { subagentId: 'agent-0', subagentName: 'explore', parentToolCallId: 'call-2', runInBackground: false, swarmIndex: 1 }),
    ]);

    const items = state.turns[0]?.items ?? [];
    expect(items[1]).toMatchObject({
      type: 'tool_call',
      interaction: { interaction_id: 'i1', kind: 'approval', status: 'ended', response: { decision: 'approved', selectedLabel: 'Go' } },
    });
    expect(items[2]).toMatchObject({
      type: 'tool_call',
      agent_refs: [{ agent_id: 'agent-0', name: 'explore', swarm_index: 1, run_in_background: false }],
    });
    expect(state.pendingTools).toEqual({});
  });

  it('folds idle compaction into a system turn and running compaction into the turn', () => {
    const state = fold([
      record('full_compaction.begin', { source: 'manual' }),
      record('context.apply_compaction', { summary: 'short', compactedCount: 4, tokensBefore: 100, tokensAfter: 10 }),
      record('full_compaction.complete', {}),
      turnPrompt(0, 'p1'),
      userMessage('p1', 'go'),
      stepBegin(0, 1, 's1'),
      record('full_compaction.begin', { source: 'auto' }),
      record('full_compaction.cancel', {}),
      turnEnded(0, 'completed'),
      record('context.apply_compaction', { summary: 'legacy', compactedCount: 2 }),
    ]);

    expect(state.turns.map((turn) => `${turn.kind}:${turn.status}`)).toEqual(['system:ended', 'agent:ended', 'system:ended']);
    expect(state.turns[0]?.items[0]).toMatchObject({ type: 'compaction', trigger: 'manual', outcome: 'completed', summary: 'short', tokens_before: 100, tokens_after: 10 });
    expect(shape(state.turns[1])).toEqual(['opener:go', 'compaction:ended:cancelled']);
    expect(shape(state.turns[2])).toEqual(['compaction:ended:completed']);
  });

  it('ends blocked prompts and projects turn errors', () => {
    const state = fold([
      userMessage('p1', 'blocked input'),
      record('prompt.completed', { promptId: 'p1', reason: 'blocked' }),
      turnPrompt(1, 'p2'),
      userMessage('p2', 'fails'),
      turnEnded(1, 'failed', {
        requestId: 'req-1',
        error: { code: 'provider.rate_limit', message: 'slow down', name: 'RateLimitError', retryable: true, details: { statusCode: 429 } },
      }),
    ]);

    expect(state.turns[0]).toMatchObject({ status: 'ended', outcome: 'blocked' });
    expect(state.turns[1]?.error).toEqual({
      code: 'provider.rate_limit',
      message: 'slow down',
      name: 'RateLimitError',
      retryable: true,
      status_code: 429,
      request_id: 'req-1',
    });
  });

  it('ends the turns of CLI shell commands at once instead of leaving the last one running', () => {
    const state = fold([
      userMessage(undefined, '<bash-input>\nls\n</bash-input>', { kind: 'shell_command', phase: 'input' }),
      userMessage(undefined, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>', { kind: 'shell_command', phase: 'output' }),
    ]);

    expect(state.turns.map((turn) => `${turn.status}:${turn.outcome}`)).toEqual(['ended:completed', 'ended:completed']);
    expect(state.openTurnId).toBeUndefined();
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

    expect(state.turns.map((turn) => `${shape(turn).join('|')}:${turn.status}:${turn.outcome}`)).toEqual([
      'assistant_message:t0#0:Blocked by policy:ended:completed',
      'opener:do the thing:ended:blocked',
      'assistant_message:t2#0:Blocked again:ended:completed',
    ]);
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

    expect(state.turns.map((turn) => `${turn.turn_number}:${turn.status}:${turn.outcome}`)).toEqual([
      'undefined:ended:completed',
      'undefined:ended:blocked',
    ]);
    expect(state.pendingPrompt).toBeUndefined();
  });

  it('keeps a running turn open while ownerless messages land beside it', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'work'),
      stepBegin(0, 1, 's1'),
      userMessage(undefined, '<bash-input>\nls\n</bash-input>', { kind: 'shell_command', phase: 'input' }),
      userMessage(undefined, '<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>', { kind: 'shell_command', phase: 'output' }),
    ]);
    expect(state.turns.map((turn) => turn.status)).toEqual(['running', 'ended', 'ended']);
    expect(state.openTurnId).toBe('t0');

    for (const entry of [contentPart(0, 1, 's1', { type: 'text', text: 'done' }, 0), stepEnd(0, 1, 's1'), turnEnded(0, 'completed')]) {
      applyConversationRecord(state, entry);
    }

    expect(state.turns.map((turn) => `${turn.turn_number}:${turn.outcome}`)).toEqual([
      '0:completed',
      'undefined:completed',
      'undefined:completed',
    ]);
    expect(shape(state.turns[0])).toEqual(['opener:work', 'assistant_message:s1:0:done']);
  });

  it('keeps the assistant run of an imported session in the turn its synthesized prompt opened', () => {
    const state = fold([
      turnPrompt(undefined, undefined, { kind: 'system_trigger', name: 'imported_orphan' }),
      message('assistant', 'carried over'),
      message('assistant', 'still the same turn'),
      turnEnded(0, 'completed'),
    ]);

    expect(state.turns).toHaveLength(1);
    expect(shape(state.turns[0])).toEqual(['assistant_message:t0#0:carried over', 'assistant_message:t0#1:still the same turn']);
    expect(state.turns[0]).toMatchObject({ turn_number: 0, status: 'ended', outcome: 'completed' });
  });

  it('drops a dangling turn prompt that does not match the next message', () => {
    const state = fold([
      turnPrompt(4, 'p-undone'),
      userMessage(undefined, '<notification/>', { kind: 'task', taskId: 't' }),
      turnPrompt(5, 'p5'),
      userMessage('p5', 'next'),
      stepBegin(5, 1, 's5'),
    ]);

    expect(state.turns.map((turn) => turn.turn_number)).toEqual([undefined, 5]);
    expect(shape(state.turns[1])).toEqual(['opener:next']);
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

    expect(state.turns.map(shape)).toEqual([
      ['opener:first', 'assistant_message:t0#1:one'],
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
    expect(shape(turn)).toEqual(['opener:first', 'assistant_message:s1:0:one']);
    expect(turn?.steps.map((step) => step.step_id)).toEqual(['s1']);
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

    expect(shape(state.turns[0])).toEqual(['opener:read it', 'reasoning:t0#1:hmm', 'assistant_message:t0#2:reading', 'tool:Read_0:ended']);
    expect(state.turns[0]?.items[3]).toMatchObject({ input: { path: 'a.ts' }, output: 'file body', is_error: true });
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

    expect(state.turns.map((turn) => `${turn.turn_number}:${turn.outcome}`)).toEqual(['21:completed', '12:cancelled']);
    expect(shape(state.turns[0])).toEqual(['opener:long task', 'assistant_message:s21:0:done']);
  });

  it('clears the conversation on context clear', () => {
    const state = fold([userMessage('a', 'one'), record('context.clear', {}), userMessage('b', 'two')]);

    expect(state.turns.map(shape)).toEqual([['opener:two']]);
    expect(state.turns[0]?.ordinal).toBe(1);
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

  it('ends a running turn nothing runs anymore as interrupted, with its items, without touching the input', () => {
    const state = unfinished();
    const before = structuredClone(state);

    const settled = settleOrphanTurns(state);

    expect(state).toEqual(before);
    expect(settled.turns[0]).toMatchObject({ status: 'ended', outcome: 'interrupted' });
    expect(settled.turns[0]?.items[1]).toMatchObject({ status: 'ended', interaction: { status: 'ended' } });
    expect(settled.openTurnId).toBeUndefined();
  });

  it('keeps the turn the loop is running and a system turn whose compaction still runs', () => {
    const state = unfinished();
    expect(settleOrphanTurns(state, { turnNumber: 0 })).toBe(state);

    const compacting = fold([record('full_compaction.begin', { source: 'manual' })]);
    expect(settleOrphanTurns(compacting, { compacting: true })).toBe(compacting);
    const settled = settleOrphanTurns(compacting);
    expect(settled.turns[0]).toMatchObject({ kind: 'system', status: 'ended', outcome: 'interrupted' });
    expect(settled.compaction).toBeUndefined();
  });

  it('leaves an interrupted turn alone when the next prompt opens a turn', () => {
    const settled = settleOrphanTurns(unfinished());

    applyConversationRecord(settled, turnPrompt(1, 'p2'));
    applyConversationRecord(settled, userMessage('p2', 'next'));

    expect(settled.turns.map((turn) => `${turn.turn_number}:${turn.status}:${turn.outcome ?? ''}`)).toEqual([
      '0:ended:interrupted',
      '1:running:',
    ]);
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
}

function feedHarness(records: readonly WireRecord[], blobs: IAgentBlobService = passThroughBlobs): FeedHarness {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const logger = log as unknown as ILogService;
  const journal = [...records];
  let failReplay = false;
  const wire = {
    appendRecord: (entry: WireRecord) => {
      journal.push(entry);
    },
    flush: async () => {},
    readRestoreChains: async () => {
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
    [IAgentFullCompactionService, { compacting: null }],
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
  };
}

const prompt = (turnId: number, promptId: string): TurnPrompt =>
  new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' }, promptId, turnId });

const userPrompt = (id: string, text: string): ContextAppendMessage =>
  new ContextAppendMessage({ agentId: 'main', message: { role: 'user', id, content: [{ type: 'text', text }], origin: { kind: 'user' } } });

const loopEvent = (event: LoopRecordedEvent): ContextAppendLoopEvent => new ContextAppendLoopEvent({ agentId: 'main', event });

const flushed = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const turnSummary = (turn: ConversationTurn): string => `${turn.turn_number}:${turn.status}:${turn.outcome ?? ''}`;

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
    expect(orphan).toMatchObject({ turn_number: 0, status: 'ended', outcome: 'interrupted' });
    expect(orphan?.items[1]).toMatchObject({ type: 'tool_call', status: 'ended', interaction: { status: 'ended' } });

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

    await h.dispatcher.restore();
    expect(h.events.map((event) => event.type)).toEqual(['reset']);
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

  it('announces a turn before the live items streamed into it', async () => {
    const h = feedHarness([]);
    await h.dispatcher.restore();
    await h.feed.ready;

    void h.dispatcher.dispatch(prompt(0, 'p1'));
    void h.dispatcher.dispatch(userPrompt('p1', 'stream'));
    void h.dispatcher.dispatch(loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }));
    void h.dispatcher.dispatch(new AssistantDelta({ agentId: 'main', turnId: 0, block: 0, delta: 'hi' }));

    expect(h.events.map((event) => ('item' in event ? `${event.type}:${event.item.item_id}` : event.type))).toEqual([
      'turn.started',
      'item.ended:p1',
      'item.started:s1:0',
    ]);
    h.dispatcher.dispose();
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
      output: [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', imageUrl: { url: 'blobref:image/png;broken' } },
      ],
    });
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.dispatcher.dispose();
  });
});

describe('blob-backed media', () => {
  it('finds offloaded image, video and audio in tool output', () => {
    const tool = (part: Record<string, unknown>): ConversationItem => ({
      type: 'tool_call',
      item_id: 'call-1',
      status: 'ended',
      name: 'ReadMediaFile',
      output: [part],
    });

    expect(hasBlobRef(tool({ type: 'image_url', imageUrl: { url: 'blobref:a' } }))).toBe(true);
    expect(hasBlobRef(tool({ type: 'video_url', videoUrl: { url: 'blobref:b' } }))).toBe(true);
    expect(hasBlobRef(tool({ type: 'audio_url', audioUrl: { url: 'blobref:c' } }))).toBe(true);
    expect(hasBlobRef(tool({ type: 'video_url', videoUrl: { url: 'https://example.com/clip.mp4' } }))).toBe(false);
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
