import { describe, expect, it } from 'vitest';

import { isVolatileEventType, VOLATILE_EVENT_TYPES } from '../events';
import {
  inFlightTurnSchema,
  sessionSnapshotResponseSchema,
} from '../rest/snapshot';

const TS = '2026-06-11T10:30:00.000Z';

const SESSION = {
  id: 'sess_1',
  workspace_id: 'wd_demo_0123456789ab',
  title: 'demo',
  created_at: TS,
  updated_at: TS,
  status: 'running',
  metadata: { cwd: '/tmp/demo' },
  agent_config: { model: 'kimi' },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  },
  permission_rules: [],
  message_count: 2,
  last_seq: 12,
};

describe('rest/snapshot — session snapshot', () => {
  it('parses a full snapshot with an in-flight turn', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 12,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: {
        items: [
          {
            id: 'msg_sess_1_000000',
            session_id: 'sess_1',
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
            created_at: TS,
          },
        ],
        has_more: false,
      },
      in_flight_turn: {
        turn_id: 3,
        assistant_text: 'partial answer…',
        thinking_text: '',
        running_tools: [
          {
            tool_call_id: 'call_1',
            name: 'Bash',
            args: { command: 'ls' },
            last_progress: { kind: 'stdout', text: 'src\n' },
          },
        ],
      },
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
  });

  it('parses an idle snapshot (no in-flight turn)', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 0,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
  });

  it('parses an in-flight turn with current_prompt_id', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 12,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: {
        turn_id: 3,
        assistant_text: 'partial answer…',
        thinking_text: '',
        running_tools: [],
        current_prompt_id: 'prompt_01KV589KCS5PG9ZYDNP8KFDQHZ',
      },
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.in_flight_turn?.current_prompt_id).toBe(
        'prompt_01KV589KCS5PG9ZYDNP8KFDQHZ',
      );
    }
  });

  it('parses a snapshot with a subagent roster', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      as_of_seq: 12,
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      subagents: [
        {
          id: 'agent_1',
          session_id: 'sess_1',
          kind: 'subagent',
          description: 'explore the auth flow',
          status: 'running',
          created_at: TS,
          started_at: TS,
          subagent_phase: 'working',
          subagent_type: 'explore',
          parent_tool_call_id: 'call_1',
          swarm_index: 0,
          run_in_background: false,
        },
        {
          id: 'agent_2',
          session_id: 'sess_1',
          kind: 'subagent',
          description: 'write tests',
          status: 'completed',
          created_at: TS,
          completed_at: TS,
          output_preview: 'done',
          subagent_phase: 'completed',
          swarm_index: 1,
        },
      ],
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagents).toHaveLength(2);
      expect(result.data.subagents?.[0]?.parent_tool_call_id).toBe('call_1');
      expect(result.data.subagents?.[1]?.subagent_phase).toBe('completed');
    }
  });

  it('rejects a snapshot missing the watermark', () => {
    const result = sessionSnapshotResponseSchema.safeParse({
      epoch: 'ep_01ABC',
      session: SESSION,
      messages: { items: [], has_more: false },
      in_flight_turn: null,
      pending_approvals: [],
      pending_questions: [],
    });
    expect(result.success).toBe(false);
  });

  it('in_flight_turn requires accumulated text fields', () => {
    expect(
      inFlightTurnSchema.safeParse({ turn_id: 1, running_tools: [] }).success,
    ).toBe(false);
  });
});

describe('events — volatile classification', () => {
  it('classifies stream fragments and periodic status as volatile', () => {
    for (const type of [
      'assistant.delta',
      'thinking.delta',
      'tool.call.delta',
      'tool.progress',
      'shell.output',
      'shell.started',
      'agent.status.updated',
    ]) {
      expect(isVolatileEventType(type)).toBe(true);
    }
    expect(VOLATILE_EVENT_TYPES).toHaveLength(7);
  });

  it('keeps timeline-bearing events durable', () => {
    for (const type of [
      'turn.started',
      'turn.ended',
      'tool.call.started',
      'tool.result',
      'session.meta.updated',
      'error',
    ]) {
      expect(isVolatileEventType(type)).toBe(false);
    }
  });
});
