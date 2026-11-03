import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';
import { describe, expect, it } from 'vitest';

import type { ConversationTurn } from '../../src/protocol/conversation';
import {
  applyConversationRecord,
  createConversationState,
  type ConversationState,
} from '../../src/services/conversation/conversationFold';

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
      ['opener:Continue working toward the active goal'],
    ]);
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
      userMessage('a', 'first'),
      message('assistant', 'one'),
      userMessage('b', 'second'),
      message('assistant', 'two'),
      record('turn.steer', { input: [{ type: 'text', text: 'wait' }], origin: { kind: 'user' } }),
      userMessage('c', 'wait'),
      message('assistant', 'three'),
      record('context.undo', { count: 1 }),
      record('context.undo', { count: 1 }),
      userMessage('d', 'third'),
    ]);

    expect(state.turns.map(shape)).toEqual([
      ['opener:first', 'assistant_message:t0#1:one'],
      ['opener:third'],
    ]);
  });

  it('folds legacy assistant and tool messages', () => {
    const state = fold([
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
