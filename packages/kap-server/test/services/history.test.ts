import { describe, expect, it } from 'vitest';

import {
  historyMessageSchema,
  type HistoryMessage,
  type ServerMessage,
  serverMessageSchema,
} from '../../src/protocol/messages';
import { AgentMessageProjector } from '../../src/services/projection/agentProjector';
import type { ProjectionBusEvent } from '../../src/services/projection/events';
import type { ContextRecord } from '../../src/services/projection/heal';
import { foldTimelineSeed } from '../../src/services/projection/heal';
import { foldWireHistory, paginateHistory, type ColdFoldOptions } from '../../src/services/history';

const SESSION = 's1';
const T0 = 1_700_000_000_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function rec(type: string, fields: Record<string, unknown> = {}, time = T0): ContextRecord {
  return { type, time, ...fields } as ContextRecord;
}

function loopEvent(event: Record<string, unknown>, time = T0): ContextRecord {
  return rec('context.append_loop_event', { event }, time);
}

function fold(
  records: readonly ContextRecord[],
  opts: Partial<ColdFoldOptions> = {},
): HistoryMessage[] {
  const out = foldWireHistory(records, {
    sessionId: SESSION,
    agentId: 'main',
    live: false,
    fallbackTimestamp: iso(T0),
    ...opts,
  });
  for (const message of out) historyMessageSchema.parse(message);
  return out;
}

function ofType<T extends HistoryMessage['type']>(
  messages: readonly HistoryMessage[],
  type: T,
): Extract<HistoryMessage, { type: T }>[] {
  return messages.filter((m): m is Extract<HistoryMessage, { type: T }> => m.type === type);
}

function ev(payload: Record<string, unknown>): ProjectionBusEvent {
  return { time: T0, ...payload } as unknown as ProjectionBusEvent;
}

describe('foldWireHistory turn lifecycle', () => {
  const records: ContextRecord[] = [
    rec('turn.prompt', {
      input: [{ type: 'text', text: 'fix the bug' }],
      origin: { kind: 'user' },
      promptId: 'p1',
    }),
    rec(
      'context.append_message',
      {
        message: {
          id: 'p1',
          role: 'user',
          content: [{ type: 'text', text: 'fix the bug' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      T0 + 1,
    ),
    loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 2),
    loopEvent({ type: 'content.part', stepUuid: 'u1', part: { type: 'think', think: 'hmm' } }, T0 + 3),
    loopEvent({ type: 'content.part', stepUuid: 'u1', part: { type: 'text', text: 'Hello' } }, T0 + 4),
    loopEvent(
      { type: 'tool.call', stepUuid: 'u1', toolCallId: 'call_1', name: 'Bash', args: '{"command":"ls"}' },
      T0 + 5,
    ),
    loopEvent({ type: 'tool.result', toolCallId: 'call_1', result: { output: 'file.txt' } }, T0 + 6),
    loopEvent(
      {
        type: 'step.end',
        uuid: 'u1',
        finishReason: 'stop',
        usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
        llmFirstTokenLatencyMs: 100,
        llmStreamDurationMs: 900,
      },
      T0 + 7,
    ),
    rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 1500 }, T0 + 8),
  ];

  it('rebuilds a full turn into flat entity messages with shared id rules', () => {
    const messages = fold(records);
    expect(messages.map((m) => m.type)).toEqual([
      'turn',
      'user',
      'step',
      'thinking',
      'assistant',
      'tool_call',
    ]);
    const turn = ofType(messages, 'turn')[0]!;
    expect(turn).toMatchObject({
      turn_id: 't0',
      ordinal: 0,
      state: 'completed',
      origin: { kind: 'user' },
      user_message_id: 't0.u0',
      started_at: iso(T0),
      ended_at: iso(T0 + 8),
      duration_ms: 1500,
      usage: { input_tokens: 11, output_tokens: 5, cached_tokens: 2 },
    });
    const user = ofType(messages, 'user')[0]!;
    expect(user).toMatchObject({
      message_id: 't0.u0',
      turn_id: 't0',
      text: 'fix the bug',
      status: 'completed',
      created_at: iso(T0),
      finished_at: iso(T0 + 8),
    });
    const step = ofType(messages, 'step')[0]!;
    expect(step).toMatchObject({
      step_id: 't0.1',
      ordinal: 1,
      state: 'completed',
      started_at: iso(T0 + 2),
      ended_at: iso(T0 + 7),
      usage: { input_other: 10, output: 5, input_cache_read: 2, input_cache_creation: 1 },
      finish_reason: 'stop',
      timing: { llm_first_token_ms: 100, llm_stream_duration_ms: 900 },
    });
    const thinking = ofType(messages, 'thinking')[0]!;
    expect(thinking).toMatchObject({ message_id: 't0.1.a1', status: 'completed', text: 'hmm' });
    const assistant = ofType(messages, 'assistant')[0]!;
    expect(assistant).toMatchObject({ message_id: 't0.1.a2', status: 'completed', text: 'Hello' });
    const tool = ofType(messages, 'tool_call')[0]!;
    expect(tool).toMatchObject({
      tool_call_id: 'call_1',
      step_id: 't0.1',
      name: 'Bash',
      state: 'done',
      input: { command: 'ls' },
      output: 'file.txt',
    });
  });

  it('finalizes an unfinished turn by session liveness', () => {
    const inFlight: ContextRecord[] = [
      rec('turn.prompt', { input: [{ type: 'text', text: 'go' }], origin: { kind: 'user' } }),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 1),
      loopEvent({ type: 'content.part', stepUuid: 'u1', part: { type: 'text', text: 'partial' } }, T0 + 2),
      loopEvent(
        { type: 'tool.call', stepUuid: 'u1', toolCallId: 'call_1', name: 'Bash', args: '{}' },
        T0 + 3,
      ),
      rec('interaction.request', {
        id: 'apr-1',
        kind: 'approval',
        toolCallId: 'call_1',
        request: { toolCallId: 'call_1', toolName: 'Bash', action: 'Run' },
      }),
    ];
    const live = fold(inFlight, { live: true });
    expect(ofType(live, 'turn')[0]).toMatchObject({ state: 'running' });
    expect(ofType(live, 'step')[0]).toMatchObject({ state: 'running' });
    expect(ofType(live, 'assistant')[0]).toMatchObject({ status: 'streaming', text: 'partial' });
    expect(ofType(live, 'tool_call')[0]).toMatchObject({ state: 'running' });
    expect(ofType(live, 'user')[0]).toMatchObject({ status: 'running' });
    expect(ofType(live, 'interaction')[0]).toMatchObject({ state: 'pending' });

    const dead = fold(inFlight);
    expect(ofType(dead, 'turn')[0]).toMatchObject({ state: 'completed' });
    expect(ofType(dead, 'step')[0]).toMatchObject({ state: 'interrupted' });
    expect(ofType(dead, 'assistant')[0]).toMatchObject({ status: 'completed' });
    expect(ofType(dead, 'tool_call')[0]).toMatchObject({ state: 'done' });
    expect(ofType(dead, 'user')[0]).toMatchObject({ status: 'completed' });
    expect(ofType(dead, 'interaction')[0]).toMatchObject({ state: 'cancelled' });
  });
});

describe('foldWireHistory origin classification', () => {
  it('maps prompt origins to turn origins and hides non-visible prompts', () => {
    const prompts: [number, Record<string, unknown>][] = [
      [0, { kind: 'user' }],
      [1, { kind: 'cron_job', jobId: 'j1', cron: '*/5 * * * *' }],
      [2, { kind: 'task', taskId: 'task-9' }],
      [3, { kind: 'hook_result', event: 'SessionStart' }],
      [4, { kind: 'system_trigger', name: 'goal_continuation' }],
      [5, { kind: 'system_trigger', name: 'subagent' }],
      [6, { kind: 'injection', variant: 'reminder' }],
      [7, { kind: 'retry' }],
      [8, { kind: 'compaction_summary' }],
      [9, { kind: 'skill_activation', trigger: 'user-slash', activationId: 'a1', skillName: 'review' }],
      [10, { kind: 'shell_command', phase: 'input' }],
      [11, { kind: 'background_task', taskId: 'task-7' }],
    ];
    const records: ContextRecord[] = prompts.map(([ordinal, origin]) =>
      rec('turn.prompt', { input: [{ type: 'text', text: `p${ordinal}` }], origin }, T0 + ordinal),
    );
    const messages = fold(records);
    const turns = ofType(messages, 'turn');
    expect(turns.map((t) => t.turn_id)).toEqual([
      't0',
      't1',
      't2',
      't3',
      't4',
      't5',
      't9',
      't10',
      't11',
    ]);
    expect(turns.map((t) => t.origin)).toEqual([
      { kind: 'user' },
      { kind: 'cron' },
      { kind: 'task', task_id: 'task-9' },
      { kind: 'hook' },
      { kind: 'goal' },
      { kind: 'other' },
      { kind: 'user' },
      { kind: 'user' },
      { kind: 'task', task_id: 'task-7' },
    ]);
    const cronUser = ofType(messages, 'user').find((u) => u.turn_id === 't1')!;
    expect(cronUser.origin).toEqual({ kind: 'cron', cron_id: 'j1', schedule: '*/5 * * * *' });
    expect(ofType(messages, 'user').some((u) => u.turn_id === 't4')).toBe(false);
    const skillSystems = ofType(messages, 'system').filter((m) => m.subtype === 'skill');
    expect(skillSystems).toHaveLength(1);
    expect(skillSystems[0]!.payload).toMatchObject({ skill_name: 'review' });
  });

  it('bundles skill activations into the user message and one skill system per activation', () => {
    const messages = fold([
      rec('turn.prompt', {
        input: [
          { type: 'text', text: '/review args' },
          { type: 'text', text: 'check this' },
        ],
        origin: {
          kind: 'user',
          skillActivations: [
            { activationId: 'a1', skillName: 'review', skillArgs: 'args' },
          ],
        },
      }),
    ]);
    const user = ofType(messages, 'user')[0]!;
    expect(user).toMatchObject({
      text: 'check this',
      skill_activations: [{ skill_name: 'review', skill_args: 'args' }],
    });
    const skill = ofType(messages, 'system').find((m) => m.subtype === 'skill')!;
    expect(skill.payload).toMatchObject({
      trigger: 'user-slash',
      activation_id: 'a1',
      skill_name: 'review',
      skill_args: 'args',
      text: '/review args',
    });
  });
});

describe('foldWireHistory steer', () => {
  it('attaches steers to the running step, buffers between steps, and dedupes the turn-opening steer', () => {
    const messages = fold([
      rec('turn.prompt', { input: [{ type: 'text', text: 'do A' }], origin: { kind: 'user' } }),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 1),
      rec('turn.steer', { input: [{ type: 'text', text: 'also B' }], origin: { kind: 'user' } }, T0 + 2),
      loopEvent({ type: 'step.end', uuid: 'u1' }, T0 + 3),
      rec('turn.steer', { input: [{ type: 'text', text: 'and C' }], origin: { kind: 'user' } }, T0 + 4),
      loopEvent({ type: 'step.begin', uuid: 'u2', turnId: '0', step: 2 }, T0 + 5),
      rec('turn.ended', { turnId: 0, reason: 'completed' }, T0 + 6),
    ]);
    const users = ofType(messages, 'user');
    const inStep = users.find((u) => u.message_id === 't0.1.u1')!;
    expect(inStep).toMatchObject({
      turn_id: 't0',
      step_id: 't0.1',
      text: 'also B',
      status: 'completed',
      steered_at: iso(T0 + 2),
    });
    const buffered = users.find((u) => u.message_id === 't0.2.u1')!;
    expect(buffered).toMatchObject({ step_id: 't0.2', text: 'and C' });

    const deduped = fold([
      rec('turn.prompt', { input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' } }),
      rec('turn.steer', { input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' } }, T0 + 1),
    ]);
    const dedupedUsers = ofType(deduped, 'user');
    expect(dedupedUsers).toHaveLength(1);
    expect(dedupedUsers[0]).toMatchObject({ message_id: 't0.u0', text: 'hello' });
  });

  it('holds steers buffered at turn end on the last step, synthesizing one when none ran', () => {
    const attached = fold([
      rec('turn.prompt', { input: [{ type: 'text', text: 'do A' }], origin: { kind: 'user' } }),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 1),
      loopEvent({ type: 'step.end', uuid: 'u1' }, T0 + 2),
      rec('turn.steer', { input: [{ type: 'text', text: 'last' }], origin: { kind: 'user' } }, T0 + 3),
      rec('turn.ended', { turnId: 0, reason: 'cancelled' }, T0 + 4),
    ]);
    expect(ofType(attached, 'step').map((s) => s.step_id)).toEqual(['t0.1']);
    const steer = ofType(attached, 'user').find((u) => u.message_id === 't0.1.u1')!;
    expect(steer).toMatchObject({ step_id: 't0.1', text: 'last', status: 'completed' });

    const synthesized = fold([
      rec('turn.prompt', { input: [{ type: 'text', text: 'do A' }], origin: { kind: 'user' } }),
      rec('turn.steer', { input: [{ type: 'text', text: 'early' }], origin: { kind: 'user' } }, T0 + 1),
      rec('turn.ended', { turnId: 0, reason: 'cancelled' }, T0 + 2),
    ]);
    const step = ofType(synthesized, 'step').find((s) => s.step_id === 't0.1')!;
    expect(step).toMatchObject({ state: 'interrupted' });
    const early = ofType(synthesized, 'user').find((u) => u.message_id === 't0.1.u1')!;
    expect(early).toMatchObject({ text: 'early', status: 'completed' });
  });
});

describe('foldWireHistory undo and clear', () => {
  function anchorTurn(ordinal: number, promptId: string, time: number): ContextRecord[] {
    return [
      rec(
        'turn.prompt',
        { input: [{ type: 'text', text: promptId }], origin: { kind: 'user' }, promptId },
        time,
      ),
      rec(
        'context.append_message',
        {
          message: {
            id: promptId,
            role: 'user',
            content: [{ type: 'text', text: promptId }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        time + 1,
      ),
      rec('turn.ended', { turnId: ordinal, reason: 'completed' }, time + 2),
    ];
  }

  it('truncates undone turns and emits system(undo) with the removed top-level ids', () => {
    const messages = fold([
      ...anchorTurn(0, 'p0', T0),
      ...anchorTurn(1, 'p1', T0 + 10),
      rec('context.undo', { count: 1 }, T0 + 20),
    ]);
    expect(ofType(messages, 'turn').map((t) => t.turn_id)).toEqual(['t0']);
    const undo = ofType(messages, 'system').find((m) => m.subtype === 'undo')!;
    expect(undo).toMatchObject({ subtype: 'undo', payload: { removed_ids: ['t1'] } });
    expect(ofType(messages, 'user').map((u) => u.message_id)).toEqual(['t0.u0']);

    const both = fold([
      ...anchorTurn(0, 'p0', T0),
      ...anchorTurn(1, 'p1', T0 + 10),
      rec('context.undo', { count: 2 }, T0 + 20),
    ]);
    expect(ofType(both, 'turn')).toHaveLength(0);
    const undoBoth = ofType(both, 'system').find((m) => m.subtype === 'undo')!;
    expect(undoBoth.payload).toEqual({ removed_ids: ['t0', 't1'] });
  });

  it('does not cross the compaction anchor floor on undo', () => {
    const messages = fold([
      ...anchorTurn(0, 'p0', T0),
      rec('context.apply_compaction', { summary: 'summary', compactedCount: 1 }, T0 + 10),
      ...anchorTurn(1, 'p1', T0 + 20),
      rec('context.undo', { count: 1 }, T0 + 30),
      rec('context.undo', { count: 1 }, T0 + 31),
    ]);
    expect(ofType(messages, 'turn').map((t) => t.turn_id)).toEqual(['t0']);
    expect(ofType(messages, 'system').filter((m) => m.subtype === 'undo')).toHaveLength(1);
    const compaction = ofType(messages, 'system').find((m) => m.subtype === 'compaction')!;
    expect(compaction.payload).toEqual({ phase: 'completed', text: 'summary' });
  });

  it('rewrites the whole timeline on clear with every removed id', () => {
    const messages = fold([
      ...anchorTurn(0, 'p0', T0),
      rec('goal.create', { objective: 'ship' }, T0 + 10),
      rec('context.clear', {}, T0 + 20),
      rec(
        'turn.prompt',
        { input: [{ type: 'text', text: 'fresh' }], origin: { kind: 'user' }, promptId: 'p1' },
        T0 + 30,
      ),
    ]);
    const clear = ofType(messages, 'system').find((m) => m.subtype === 'clear')!;
    expect(clear).toMatchObject({ subtype: 'clear', payload: { removed_ids: ['t0', 'sys_goal_1'] } });
    expect(ofType(messages, 'turn').map((t) => t.turn_id)).toEqual(['t1']);
    expect(ofType(messages, 'system').filter((m) => m.subtype === 'goal')).toHaveLength(0);
  });
});

describe('foldWireHistory interactions, facts and modes', () => {
  it('projects approval interactions and links them to their tool call', () => {
    const messages = fold([
      rec('turn.prompt', { input: [{ type: 'text', text: 'go' }], origin: { kind: 'user' } }),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 'u1', toolCallId: 'call_1', name: 'Bash', args: '{}' },
        T0 + 2,
      ),
      rec(
        'interaction.request',
        {
          id: 'apr-1',
          kind: 'approval',
          toolCallId: 'call_1',
          request: {
            toolCallId: 'call_1',
            toolName: 'Bash',
            action: 'Run ls',
            display: { kind: 'command' },
          },
        },
        T0 + 3,
      ),
      rec('interaction.resolved', { id: 'apr-1', response: { decision: 'approved', scope: 'session' } }, T0 + 4),
    ]);
    const interaction = ofType(messages, 'interaction')[0]!;
    expect(interaction).toMatchObject({
      interaction_id: 'apr-1',
      kind: 'approval',
      state: 'approved',
      tool_call_id: 'call_1',
      request: { tool_name: 'Bash', action: 'Run ls', tool_input_display: { kind: 'command' } },
      response: { decision: 'approved', scope: 'session' },
    });
    expect(ofType(messages, 'tool_call')[0]!.approval_id).toBe('apr-1');
  });

  it('rewrites question payloads into the contract shape and maps answers back', () => {
    const messages = fold([
      rec('interaction.request', {
        id: 'q-1',
        kind: 'question',
        request: {
          questions: [
            {
              question: 'pick',
              header: 'h',
              options: [
                { label: 'a', description: 'da' },
                { label: 'b' },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      rec('interaction.resolved', { id: 'q-1', response: { answers: { pick: 'a' }, method: 'click' } }),
    ]);
    const interaction = ofType(messages, 'interaction')[0]!;
    expect(interaction).toMatchObject({ kind: 'question', state: 'answered' });
    expect(interaction.request).toEqual({
      questions: [
        {
          id: 'q_0',
          question: 'pick',
          header: 'h',
          options: [
            { id: 'opt_0_0', label: 'a', description: 'da' },
            { id: 'opt_0_1', label: 'b', description: undefined },
          ],
          multi_select: true,
          allow_other: true,
        },
      ],
    });
    expect(interaction.response).toEqual({
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
      method: 'click',
    });
  });

  it('folds goal, plan, swarm and task records into system and task entities', () => {
    const messages = fold([
      rec('goal.create', { objective: 'ship', completionCriterion: 'tests pass' }, T0),
      rec('goal.update', { status: 'blocked', tokensUsed: 42, budgetLimits: { tokenBudget: 100 } }, T0 + 1),
      rec('goal.clear', {}, T0 + 2),
      rec('plan_mode.enter', { id: 'plan-1' }, T0 + 3),
      rec(
        'plan.revision',
        { id: 'r1', version: 2, key: 'plan/x/v2.md', sha256: 'abc', bytes: 10 },
        T0 + 4,
      ),
      rec('plan_mode.exit', {}, T0 + 5),
      rec('plan_mode.enter', { id: 'plan-2' }, T0 + 6),
      rec('plan_mode.cancel', {}, T0 + 7),
      rec('swarm_mode.enter', { trigger: 'user' }, T0 + 8),
      rec('swarm_mode.exit', {}, T0 + 9),
      rec(
        'task.started',
        {
          info: {
            taskId: 'task-1',
            kind: 'process',
            status: 'running',
            description: 'dev server',
            detached: true,
            startedAt: T0,
          },
        },
        T0 + 10,
      ),
      rec(
        'task.terminated',
        {
          info: { taskId: 'task-1', kind: 'process', status: 'completed', endedAt: T0 + 11 },
          outputTail: 'logs',
        },
        T0 + 11,
      ),
    ], {
      resolvePlanRevisionKey: (key) => `resolved/${key}`,
    });
    const goals = ofType(messages, 'system').filter((m) => m.subtype === 'goal');
    expect(goals.map((m) => m.payload)).toEqual([
      { objective: 'ship', status: 'active', completion_criterion: 'tests pass', budget_used: 0, budget_limit: undefined },
      { objective: 'ship', status: 'blocked', completion_criterion: 'tests pass', budget_used: 42, budget_limit: 100 },
      undefined,
    ]);
    expect(ofType(messages, 'system').map((m) => m.subtype)).toEqual([
      'goal',
      'goal',
      'goal',
      'plan.enter',
      'plan.revision',
      'plan.exit',
      'plan.enter',
      'swarm.enter',
      'swarm.exit',
    ]);
    const revision = ofType(messages, 'system').find((m) => m.subtype === 'plan.revision')!;
    expect(revision.payload).toEqual({
      id: 'r1',
      version: 2,
      path: 'resolved/plan/x/v2.md',
      sha256: 'abc',
      bytes: 10,
    });
    const task = ofType(messages, 'task')[0]!;
    expect(task).toMatchObject({
      task_id: 'task-1',
      kind: 'shell',
      state: 'completed',
      detached: true,
      description: 'dev server',
      output_tail: 'logs',
      started_at: iso(T0),
      ended_at: iso(T0 + 11),
    });
  });

  it('links subagent tasks to their parent tool call with agent refs', () => {
    const messages = fold([
      rec('turn.prompt', { input: [{ type: 'text', text: 'go' }], origin: { kind: 'user' } }),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 'u1', toolCallId: 'call_9', name: 'Agent', args: '{}' },
        T0 + 2,
      ),
      rec(
        'task.started',
        {
          info: {
            taskId: 'task-2',
            kind: 'agent',
            agentId: 'sub-1',
            parentToolCallId: 'call_9',
            status: 'running',
            model: 'k2',
            thinkingEffort: 'high',
          },
        },
        T0 + 3,
      ),
    ]);
    const task = ofType(messages, 'task')[0]!;
    expect(task).toMatchObject({
      task_id: 'task-2',
      kind: 'subagent',
      child_agent_id: 'sub-1',
      model: 'k2',
      thinking_effort: 'high',
    });
    const tool = ofType(messages, 'tool_call')[0]!;
    expect(tool).toMatchObject({
      task_id: 'task-2',
      agent_refs: [{ agent_id: 'sub-1', role: 'child' }],
    });
  });
});

describe('foldWireHistory queued prompts and legacy messages', () => {
  it('emits queued prompts as turn-less user messages with the reserved turn id', () => {
    const messages = fold(
      [
        rec('prompt.accepted', { promptId: 'q1', content: [{ type: 'text', text: 'first' }] }, T0),
        rec('prompt.accepted', { promptId: 'q2', content: [{ type: 'text', text: 'second' }] }, T0 + 1),
        rec(
          'turn.prompt',
          { input: [{ type: 'text', text: 'first' }], origin: { kind: 'user' }, promptId: 'q1' },
          T0 + 2,
        ),
        rec('turn.ended', { turnId: 0, reason: 'completed' }, T0 + 3),
      ],
      { live: true },
    );
    const users = ofType(messages, 'user');
    expect(users.map((u) => u.message_id)).toEqual(['t0.u0', 't1.u0']);
    const queued = users[1]!;
    expect(queued).toMatchObject({ turn_id: 't1', text: 'second', status: 'running' });
    expect(queued.step_id).toBeUndefined();
    expect(ofType(messages, 'turn').map((t) => t.turn_id)).toEqual(['t0']);

    const aborted = fold([
      rec('prompt.accepted', { promptId: 'q1', content: [{ type: 'text', text: 'first' }] }, T0),
      rec('prompt.aborted', { promptId: 'q1' }, T0 + 1),
    ]);
    expect(ofType(aborted, 'user')).toHaveLength(0);
  });

  it('rebuilds legacy append-only assistant and tool messages', () => {
    const messages = fold([
      rec('context.append_message', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          toolCalls: [{ id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' }],
        },
      }),
      rec(
        'context.append_message',
        { message: { role: 'tool', content: [{ type: 'text', text: 'file.txt' }], toolCalls: [], toolCallId: 'call_1' } },
        T0 + 1,
      ),
    ]);
    const turn = ofType(messages, 'turn')[0]!;
    expect(turn).toMatchObject({ turn_id: 't0', origin: { kind: 'other' } });
    const assistant = ofType(messages, 'assistant')[0]!;
    expect(assistant).toMatchObject({ message_id: 't0.1.a1', text: 'hi', status: 'completed' });
    const tool = ofType(messages, 'tool_call')[0]!;
    expect(tool).toMatchObject({ tool_call_id: 'call_1', state: 'done', output: 'file.txt' });
  });
});

describe('foldWireHistory todo restoration', () => {
  it('restores the todo entity from the last done TodoWrite input and reverts with undo', () => {
    const first: ContextRecord[] = [
      rec('turn.prompt', { input: [{ type: 'text', text: 'one' }], origin: { kind: 'user' }, promptId: 'p0' }),
      rec(
        'context.append_message',
        {
          message: {
            id: 'p0',
            role: 'user',
            content: [{ type: 'text', text: 'one' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        T0 + 1,
      ),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 2),
      loopEvent(
        {
          type: 'tool.call',
          stepUuid: 'u1',
          toolCallId: 'call_t1',
          name: 'TodoList',
          args: '{"todos":[{"title":"a","status":"done"}]}',
        },
        T0 + 3,
      ),
      loopEvent({ type: 'tool.result', toolCallId: 'call_t1', result: { output: 'ok' } }, T0 + 4),
      rec('turn.ended', { turnId: 0, reason: 'completed' }, T0 + 5),
    ];
    const second: ContextRecord[] = [
      rec(
        'turn.prompt',
        { input: [{ type: 'text', text: 'two' }], origin: { kind: 'user' }, promptId: 'p1' },
        T0 + 10,
      ),
      rec(
        'context.append_message',
        {
          message: {
            id: 'p1',
            role: 'user',
            content: [{ type: 'text', text: 'two' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        T0 + 11,
      ),
      loopEvent({ type: 'step.begin', uuid: 'u2', turnId: '1', step: 1 }, T0 + 12),
      loopEvent(
        {
          type: 'tool.call',
          stepUuid: 'u2',
          toolCallId: 'call_t2',
          name: 'TodoList',
          args: '{"todos":[{"title":"b","status":"in_progress"}]}',
        },
        T0 + 13,
      ),
      loopEvent({ type: 'tool.result', toolCallId: 'call_t2', result: { output: 'ok' } }, T0 + 14),
      rec('turn.ended', { turnId: 1, reason: 'completed' }, T0 + 15),
    ];
    const restored = fold([...first, ...second]);
    const todo = ofType(restored, 'todo')[0]!;
    expect(todo).toMatchObject({
      todo_id: 'todo',
      items: [{ title: 'b', status: 'in_progress' }],
      updated_at: iso(T0 + 14),
    });
    expect(restored.at(-1)).toBe(todo);

    const reverted = fold([...first, ...second, rec('context.undo', { count: 1 }, T0 + 20)]);
    const revertedTodo = ofType(reverted, 'todo')[0]!;
    expect(revertedTodo).toMatchObject({ todo_id: 'todo', items: [{ title: 'a', status: 'done' }] });
  });
});

describe('paginateHistory', () => {
  const base: HistoryMessage[] = [];
  for (let turn = 0; turn < 2; turn++) {
    base.push(
      {
        type: 'turn',
        session_id: SESSION,
        agent_id: 'main',
        timestamp: iso(T0),
        turn_id: `t${turn}`,
        ordinal: turn,
        state: 'completed',
        origin: { kind: 'user' },
      },
      {
        type: 'user',
        session_id: SESSION,
        agent_id: 'main',
        timestamp: iso(T0),
        message_id: `t${turn}.u0`,
        turn_id: `t${turn}`,
        text: `p${turn}`,
        status: 'completed',
        created_at: iso(T0),
      },
      {
        type: 'step',
        session_id: SESSION,
        agent_id: 'main',
        timestamp: iso(T0),
        step_id: `t${turn}.1`,
        turn_id: `t${turn}`,
        ordinal: 1,
        state: 'completed',
      },
      {
        type: 'assistant',
        session_id: SESSION,
        agent_id: 'main',
        timestamp: iso(T0),
        message_id: `t${turn}.1.a1`,
        turn_id: `t${turn}`,
        step_id: `t${turn}.1`,
        status: 'completed',
        text: `a${turn}`,
      },
    );
  }

  const ids = (messages: readonly HistoryMessage[]): string[] =>
    messages.map((m) => {
      switch (m.type) {
        case 'turn':
          return m.turn_id;
        case 'step':
          return m.step_id;
        case 'user':
        case 'assistant':
          return m.message_id;
        default:
          return m.type;
      }
    });

  it('returns the newest page by default and pages older with before_turn', () => {
    expect(ids(paginateHistory(base, {}))).toHaveLength(8);
    expect(ids(paginateHistory(base, { page_size: 3 }))).toEqual(['t1.u0', 't1.1', 't1.1.a1']);
    expect(ids(paginateHistory(base, { before_turn: 't1' }))).toEqual([
      't0',
      't0.u0',
      't0.1',
      't0.1.a1',
    ]);
    expect(ids(paginateHistory(base, { before_turn: 't1', page_size: 2 }))).toEqual([
      't0.1',
      't0.1.a1',
    ]);
    expect(paginateHistory(base, { before_turn: 't99' })).toEqual([]);
  });

  it('catches up newer messages with after_step', () => {
    expect(ids(paginateHistory(base, { after_step: 't0.1' }))).toEqual([
      't1',
      't1.u0',
      't1.1',
      't1.1.a1',
    ]);
    expect(ids(paginateHistory(base, { after_step: 't0.1', page_size: 2 }))).toEqual([
      't1',
      't1.u0',
    ]);
    expect(paginateHistory(base, { after_step: 't0.9' })).toEqual([]);
    expect(paginateHistory(base, { after_step: 't1.1' })).toEqual([]);
  });
});

describe('live and cold rebuild id consistency', () => {
  const IDENTITY_KEY_TYPES = new Set([
    'turn',
    'step',
    'user',
    'assistant',
    'thinking',
    'tool_call',
    'system',
    'interaction',
    'task',
  ]);

  function keyOf(message: ServerMessage): string | undefined {
    switch (message.type) {
      case 'turn':
        return `turn:${message.turn_id}`;
      case 'step':
        return `step:${message.step_id}`;
      case 'user':
      case 'assistant':
      case 'thinking':
        return `${message.type}:${message.message_id}`;
      case 'tool_call':
        return `tool_call:${message.tool_call_id}`;
      case 'system':
        return `system:${message.system_id}`;
      case 'interaction':
        return `interaction:${message.interaction_id}`;
      case 'task':
        return `task:${message.task_id}`;
      default:
        return undefined;
    }
  }

  function clientFold(messages: readonly ServerMessage[]): Map<string, ServerMessage> {
    const store = new Map<string, ServerMessage>();
    const removeSubtree = (id: string): void => {
      for (const [key, entity] of [...store]) {
        if (key.endsWith(`:${id}`)) {
          store.delete(key);
          continue;
        }
        if (!IDENTITY_KEY_TYPES.has(entity.type)) continue;
        const turnId = 'turn_id' in entity ? (entity.turn_id as string | undefined) : undefined;
        if (turnId === id) store.delete(key);
      }
    };
    for (const message of messages) {
      if (message.type === 'system' && (message.subtype === 'undo' || message.subtype === 'clear')) {
        for (const id of (message.payload as { removed_ids: string[] }).removed_ids) {
          removeSubtree(id);
        }
      }
      const key = keyOf(message);
      if (key !== undefined) store.set(key, message);
    }
    return store;
  }

  it('produces the same entity id set from the live projector and the cold fold', () => {
    const projector = new AgentMessageProjector('main', SESSION, new Map());
    const live: ServerMessage[] = [];
    const feed = (event: ProjectionBusEvent): void => {
      for (const message of projector.map(event)) live.push(serverMessageSchema.parse(message));
    };

    feed(ev({ type: 'turn.started', turnId: 0, promptId: 'p1', origin: { kind: 'user' }, prompt: 'fix the bug' }));
    feed(ev({ type: 'turn.step.started', turnId: 0, step: 1 }));
    feed(ev({ type: 'thinking.delta', turnId: 0, delta: 'hmm' }));
    feed(ev({ type: 'assistant.delta', turnId: 0, delta: 'Hello' }));
    feed(ev({ type: 'tool.call.started', turnId: 0, toolCallId: 'call_1', name: 'Bash', args: '{"command":"ls"}' }));
    feed(ev({ type: 'tool.result', turnId: 0, toolCallId: 'call_1', output: 'file.txt' }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 0,
        step: 1,
        usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
        finishReason: 'tool_calls',
      }),
    );
    feed(ev({ type: 'turn.steer', turnId: 0, input: [{ type: 'text', text: 'also B' }], origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 0, step: 2 }));
    live.push(
      ...projector.interactionRequested({
        id: 'apr-1',
        kind: 'approval',
        payload: { toolCallId: 'call_1', toolName: 'Bash', action: 'Run ls' },
        origin: {},
        createdAt: T0,
      }),
    );
    live.push(...projector.interactionResolved('apr-1', { decision: 'approved' }));
    feed(
      ev({
        type: 'goal.updated',
        snapshot: {
          objective: 'ship',
          status: 'active',
          tokensUsed: 10,
          budget: { tokenBudget: 100 },
        },
      }),
    );
    feed(ev({ type: 'turn.step.completed', turnId: 0, step: 2 }));
    feed(ev({ type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 1500 }));
    feed(ev({ type: 'turn.started', turnId: 1, promptId: 'p2', origin: { kind: 'user' }, prompt: 'second' }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(ev({ type: 'assistant.delta', turnId: 1, delta: 'partial' }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    feed(ev({ type: 'context.undone', turns: 1, fromTurnId: 1 }));
    feed(ev({ type: 'compaction.completed', result: { summary: 'sum' } }));

    const records: ContextRecord[] = [
      rec('turn.prompt', {
        input: [{ type: 'text', text: 'fix the bug' }],
        origin: { kind: 'user' },
        promptId: 'p1',
      }),
      rec('context.append_message', {
        message: {
          id: 'p1',
          role: 'user',
          content: [{ type: 'text', text: 'fix the bug' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }),
      loopEvent({ type: 'content.part', stepUuid: 'u1', part: { type: 'think', think: 'hmm' } }),
      loopEvent({ type: 'content.part', stepUuid: 'u1', part: { type: 'text', text: 'Hello' } }),
      loopEvent({
        type: 'tool.call',
        stepUuid: 'u1',
        toolCallId: 'call_1',
        name: 'Bash',
        args: '{"command":"ls"}',
      }),
      loopEvent({ type: 'tool.result', toolCallId: 'call_1', result: { output: 'file.txt' } }),
      loopEvent({
        type: 'step.end',
        uuid: 'u1',
        finishReason: 'tool_calls',
        usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
      }),
      rec('turn.steer', { input: [{ type: 'text', text: 'also B' }], origin: { kind: 'user' } }),
      loopEvent({ type: 'step.begin', uuid: 'u2', turnId: '0', step: 2 }),
      rec('interaction.request', {
        id: 'apr-1',
        kind: 'approval',
        toolCallId: 'call_1',
        request: { toolCallId: 'call_1', toolName: 'Bash', action: 'Run ls' },
      }),
      rec('interaction.resolved', { id: 'apr-1', response: { decision: 'approved' } }),
      rec('goal.create', { objective: 'ship' }),
      loopEvent({ type: 'step.end', uuid: 'u2' }),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 1500 }),
      rec('turn.prompt', {
        input: [{ type: 'text', text: 'second' }],
        origin: { kind: 'user' },
        promptId: 'p2',
      }),
      rec('context.append_message', {
        message: {
          id: 'p2',
          role: 'user',
          content: [{ type: 'text', text: 'second' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
      loopEvent({ type: 'step.begin', uuid: 'u3', turnId: '1', step: 1 }),
      loopEvent({ type: 'content.part', stepUuid: 'u3', part: { type: 'text', text: 'partial' } }),
      rec('turn.ended', { turnId: 1, reason: 'completed' }),
      rec('context.undo', { count: 1 }),
      rec('context.apply_compaction', { summary: 'sum', compactedCount: 2 }),
    ];
    const cold = fold(records);

    const liveIds = [...clientFold(live).keys()].toSorted();
    const coldIds = cold
      .map((m) => keyOf(m as ServerMessage))
      .filter((k): k is string => k !== undefined)
      .toSorted();
    expect(coldIds).toEqual(liveIds);

    const coldUndo = ofType(cold, 'system').find((m) => m.subtype === 'undo')!;
    expect(coldUndo.payload).toEqual({ removed_ids: ['t1'] });
    const liveUndo = clientFold(live).get('system:sys_undo_1');
    expect(liveUndo).toMatchObject({ subtype: 'undo', payload: { removed_ids: ['t1'] } });
  });

  it('keeps system ids deterministic across live-only and multi-phase events', () => {
    const projector = new AgentMessageProjector('main', SESSION, new Map());
    const live: ServerMessage[] = [];
    const feed = (event: ProjectionBusEvent): void => {
      for (const message of projector.map(event)) live.push(serverMessageSchema.parse(message));
    };

    feed(ev({ type: 'turn.started', turnId: 0, promptId: 'p1', origin: { kind: 'user' }, prompt: 'fix' }));
    feed(ev({ type: 'turn.step.started', turnId: 0, step: 1 }));
    feed(ev({ type: 'hook.result', turnId: 0, hookEvent: 'PreToolUse', content: 'hook says hi' }));
    feed(ev({ type: 'warning', message: 'careful', code: 'W1' }));
    feed(ev({ type: 'compaction.started', trigger: 'manual' }));
    feed(ev({ type: 'compaction.completed', result: { summary: 'sum' } }));
    feed(ev({ type: 'compaction.started', trigger: 'manual' }));
    feed(ev({ type: 'compaction.completed', result: { summary: 'sum2' } }));
    feed(ev({ type: 'turn.step.completed', turnId: 0, step: 1 }));
    feed(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
    feed(
      ev({
        type: 'turn.started',
        turnId: 1,
        promptId: 'p2',
        origin: { kind: 'skill_activation', trigger: 'user-slash', activationId: 'sk-1', skillName: 'review' },
        prompt: 'run review',
      }),
    );
    feed(ev({ type: 'skill.activated', activationId: 'sk-1', skillName: 'review', trigger: 'user-slash' }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    const records: ContextRecord[] = [
      rec('turn.prompt', {
        input: [{ type: 'text', text: 'fix' }],
        origin: { kind: 'user' },
        promptId: 'p1',
      }),
      rec('context.append_message', {
        message: {
          id: 'p1',
          role: 'user',
          content: [{ type: 'text', text: 'fix' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
      loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }),
      rec('context.apply_compaction', { summary: 'sum', compactedCount: 1 }),
      rec('context.apply_compaction', { summary: 'sum2', compactedCount: 1 }),
      loopEvent({ type: 'step.end', uuid: 'u1' }),
      rec('turn.ended', { turnId: 0, reason: 'completed' }),
      rec('turn.prompt', {
        input: [{ type: 'text', text: 'run review' }],
        origin: { kind: 'skill_activation', trigger: 'user-slash', activationId: 'sk-1', skillName: 'review' },
        promptId: 'p2',
      }),
      rec('context.append_message', {
        message: {
          id: 'p2',
          role: 'user',
          content: [{ type: 'text', text: 'run review' }],
          toolCalls: [],
          origin: { kind: 'skill_activation', trigger: 'user-slash' },
        },
      }),
      rec('turn.ended', { turnId: 1, reason: 'completed' }),
    ];
    const cold = fold(records);

    const liveSystems = live.filter(
      (m): m is Extract<ServerMessage, { type: 'system' }> => m.type === 'system',
    );
    expect(liveSystems.filter((m) => m.subtype === 'compaction')).toHaveLength(2);
    const coldSysIds = ofType(cold, 'system').map((m) => m.system_id).toSorted();
    expect(coldSysIds).toEqual(['sys_compaction_1', 'sys_compaction_2', 'sys_skill_1']);
    const liveOnlySysIds = liveSystems
      .map((m) => m.system_id)
      .filter((id) => !coldSysIds.includes(id))
      .toSorted();
    expect(liveOnlySysIds).toEqual(['sys_hook_1', 'sys_notice_1']);

    const liveIds = [...clientFold(live).keys()].toSorted();
    const coldIds = cold
      .map((m) => keyOf(m as ServerMessage))
      .filter((k): k is string => k !== undefined)
      .toSorted();
    expect(coldIds.every((id) => liveIds.includes(id))).toBe(true);
    expect(liveIds.filter((id) => !coldIds.includes(id)).toSorted()).toEqual([
      'system:sys_hook_1',
      'system:sys_notice_1',
    ]);
  });

  it('seeds the same timeline ids and counters as the cold fold', () => {
    const records: ContextRecord[] = [
      rec('turn.prompt', {
        input: [{ type: 'text', text: 'one' }],
        origin: { kind: 'user' },
        promptId: 'p0',
      }),
      rec(
        'context.append_message',
        {
          message: {
            id: 'p0',
            role: 'user',
            content: [{ type: 'text', text: 'one' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        T0 + 1,
      ),
      rec('turn.ended', { turnId: 0, reason: 'completed' }, T0 + 2),
      rec('goal.create', { objective: 'ship' }, T0 + 3),
      rec('goal.update', { tokensUsed: 42 }, T0 + 4),
      rec(
        'turn.prompt',
        { input: [{ type: 'text', text: 'two' }], origin: { kind: 'user' }, promptId: 'p1' },
        T0 + 10,
      ),
      rec(
        'context.append_message',
        {
          message: {
            id: 'p1',
            role: 'user',
            content: [{ type: 'text', text: 'two' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        },
        T0 + 11,
      ),
      rec('turn.ended', { turnId: 1, reason: 'completed' }, T0 + 12),
      rec('context.undo', { count: 1 }, T0 + 20),
      rec('context.apply_compaction', { summary: 'sum', compactedCount: 1 }, T0 + 21),
      rec('plan_mode.enter', { id: 'plan-1' }, T0 + 22),
      rec('plan_mode.cancel', {}, T0 + 23),
      rec(
        'turn.prompt',
        { input: [{ type: 'text', text: 'three' }], origin: { kind: 'cron_job', jobId: 'j1', cron: '* * * * *' } },
        T0 + 24,
      ),
      rec('turn.ended', { turnId: 2, reason: 'completed' }, T0 + 25),
    ];
    const seed = foldTimelineSeed(records);
    const cold = fold(records);
    const coldTimelineIds = cold
      .filter((m) => m.type === 'turn' || m.type === 'system')
      .map((m) => (m.type === 'turn' ? m.turn_id : m.system_id));
    expect(seed.timelineIds).toEqual(coldTimelineIds);
    expect(seed.timelineIds).toEqual([
      't0',
      'sys_goal_1',
      'sys_undo_1',
      'sys_compaction_1',
      'sys_plan.enter_1',
      't2',
    ]);
    expect(seed.nextTurnId).toBe(3);
    expect(seed.anchorTurnOrdinals).toEqual([0, 1]);
    expect(seed.systemCounts).toEqual(
      new Map([['compaction', 1], ['goal', 1], ['plan.enter', 1], ['undo', 1]]),
    );

    const legacy: ContextRecord[] = [
      rec('context.append_message', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          toolCalls: [{ id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' }],
        },
      }),
      rec(
        'turn.prompt',
        { input: [{ type: 'text', text: 'next' }], origin: { kind: 'user' }, promptId: 'p9' },
        T0 + 10,
      ),
    ];
    const legacySeed = foldTimelineSeed(legacy);
    const legacyColdIds = fold(legacy)
      .filter((m) => m.type === 'turn' || m.type === 'system')
      .map((m) => (m.type === 'turn' ? m.turn_id : m.system_id));
    expect(legacySeed.timelineIds).toEqual(legacyColdIds);
    expect(legacySeed.nextTurnId).toBe(2);
  });
});
