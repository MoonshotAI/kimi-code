import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import {
  MAX_SUBAGENT_ACTIVITY_STEPS,
  SUBAGENT_ARG_STRING_MAX_CHARS,
  SUBAGENT_STEP_TEXT_TAIL_CHARS,
  SUBAGENT_TOOL_OUTPUT_MAX_CHARS,
} from '#/tui/constant/rendering';
import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from '#/tui/constant/streaming';
import {
  SubagentActivityStore,
  type SubagentActivitySpawn,
} from '#/tui/controllers/subagent-activity-store';

function ev(partial: Record<string, unknown>): Event {
  return { sessionId: 's1', agentId: 'agent-1', ...partial } as unknown as Event;
}

function spawn(overrides: Partial<SubagentActivitySpawn> = {}): SubagentActivitySpawn {
  return {
    agentId: 'agent-1',
    agentName: 'explore',
    description: 'find things',
    parentToolCallId: 'tc-1',
    model: 'K3',
    effort: 'high',
    ...overrides,
  };
}

describe('SubagentActivityStore', () => {
  it('folds a full step lifecycle (text + tool call + result)', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: 0 }));
    store.applyEvent(ev({ type: 'assistant.delta', turnId: 1, delta: 'Hello ' }));
    store.applyEvent(ev({ type: 'assistant.delta', turnId: 1, delta: 'world' }));
    store.applyEvent(
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 't1', name: 'Grep', args: { pattern: 'foo' } }),
    );
    store.applyEvent(
      ev({ type: 'tool.progress', turnId: 1, toolCallId: 't1', update: { kind: 'stdout', text: 'line1\nline2\n' } }),
    );
    store.applyEvent(
      ev({ type: 'tool.result', turnId: 1, toolCallId: 't1', output: 'a\nb\nc', isError: false }),
    );

    const record = store.get('agent-1');
    expect(record?.agentName).toBe('explore');
    expect(record?.steps).toHaveLength(1);
    expect(record?.totalSteps).toBe(1);
    expect(record?.steps[0]?.textTail).toBe('Hello world');
    const call = record?.steps[0]?.toolCalls[0];
    expect(call?.name).toBe('Grep');
    expect(call?.args).toEqual({ pattern: 'foo' });
    expect(call?.status).toBe('done');
    expect(call?.result?.output).toBe('a\nb\nc');
    expect(call?.result?.is_error).toBe(false);
    expect(call?.liveOutputTail).toBeUndefined();
    expect(call?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.version).toBeGreaterThan(0);
  });

  it('shows a status progress update as the live output tail', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 't1', name: 'WaitFor', args: { timeout: 600 } }),
    );
    store.applyEvent(
      ev({
        type: 'tool.progress',
        turnId: 1,
        toolCallId: 't1',
        update: { kind: 'status', text: 'Waiting 10s / 600s · 1 background task still running', replace: true },
      }),
    );

    const call = store.get('agent-1')?.steps[0]?.toolCalls[0];
    expect(call?.liveOutputTail).toBe('Waiting 10s / 600s · 1 background task still running');
  });

  it('creates a call from streaming deltas and replaces args on start', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(
      ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 't1', name: 'Bash', argumentsPart: '{"command":"ls' }),
    );
    store.applyEvent(
      ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 't1', argumentsPart: ' -la"}' }),
    );

    let record = store.get('agent-1');
    // No step event yet — a synthetic step holds the in-flight call.
    expect(record?.steps).toHaveLength(1);
    expect(record?.steps[0]?.toolCalls[0]?.args).toEqual({ command: 'ls -la' });

    store.applyEvent(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 't1',
        name: 'Bash',
        args: { command: 'ls -la', timeout: 5 },
      }),
    );
    record = store.get('agent-1');
    expect(record?.steps[0]?.toolCalls[0]?.args).toEqual({ command: 'ls -la', timeout: 5 });
  });

  it('evicts whole steps beyond the cap while totalSteps keeps counting', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    for (let i = 0; i < MAX_SUBAGENT_ACTIVITY_STEPS + 2; i++) {
      store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: i }));
    }
    const record = store.get('agent-1');
    expect(record?.steps).toHaveLength(MAX_SUBAGENT_ACTIVITY_STEPS);
    expect(record?.totalSteps).toBe(MAX_SUBAGENT_ACTIVITY_STEPS + 2);
    expect(record?.steps[0]?.step).toBe(2);
  });

  it('keeps only the tail of long assistant text', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: 0 }));
    store.applyEvent(
      ev({
        type: 'assistant.delta',
        turnId: 1,
        delta: 'x'.repeat(SUBAGENT_STEP_TEXT_TAIL_CHARS) + 'y'.repeat(100),
      }),
    );
    const step = store.get('agent-1')?.steps[0];
    expect(step?.textTail).toHaveLength(SUBAGENT_STEP_TEXT_TAIL_CHARS);
    expect(step?.textTail.endsWith('y'.repeat(100))).toBe(true);
  });

  it('caps tool output and appends a truncation sentinel', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: 0 }));
    store.applyEvent(
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 't1', name: 'Bash', args: {} }),
    );
    store.applyEvent(
      ev({
        type: 'tool.result',
        turnId: 1,
        toolCallId: 't1',
        output: 'y'.repeat(SUBAGENT_TOOL_OUTPUT_MAX_CHARS + 100),
      }),
    );
    const call = store.get('agent-1')?.steps[0]?.toolCalls[0];
    expect(call?.result?.output.startsWith('yyy')).toBe(true);
    expect(call?.result?.output).toContain('[output truncated');
    expect(call?.result?.output.length).toBeLessThan(SUBAGENT_TOOL_OUTPUT_MAX_CHARS + 120);
  });

  it('marks the current step on retry without opening a new one', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: 0 }));
    store.applyEvent(
      ev({
        type: 'turn.step.retrying',
        turnId: 1,
        step: 0,
        nextAttempt: 2,
        maxAttempts: 5,
        errorName: 'RateLimitError',
      }),
    );
    let record = store.get('agent-1');
    expect(record?.steps).toHaveLength(1);
    expect(record?.steps[0]?.retrying).toContain('2/5');

    store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    record = store.get('agent-1');
    expect(record?.steps[1]?.retrying).toBeUndefined();
  });

  it('implicitly creates a record for events from an unseen agent', () => {
    const store = new SubagentActivityStore();
    store.applyEvent(ev({ type: 'assistant.delta', turnId: 1, delta: 'hi' }));
    const record = store.get('agent-1');
    expect(record?.agentName).toBe('agent-1');
    expect(record?.steps[0]?.textTail).toBe('hi');
  });

  it('drops results for unknown agents instead of creating records', () => {
    const store = new SubagentActivityStore();
    store.applyEvent(ev({ type: 'tool.result', turnId: 1, toolCallId: 't1', output: 'x' }));
    expect(store.get('agent-1')).toBeUndefined();
  });

  it('caps the raw streaming-args buffer at the preview window', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(
      ev({
        type: 'tool.call.delta',
        turnId: 1,
        toolCallId: 't1',
        name: 'Write',
        argumentsPart: 'x'.repeat(STREAMING_ARGS_PREVIEW_MAX_CHARS + 1000),
      }),
    );
    const buffers = (
      store as unknown as { streamingArgs: Map<string, string> }
    ).streamingArgs;
    expect(buffers.get('agent-1:t1')?.length).toBeLessThanOrEqual(STREAMING_ARGS_PREVIEW_MAX_CHARS);
  });

  it('tracks terminal state and resets it on respawn', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.markCompleted('agent-1', 'done summary');
    let record = store.get('agent-1');
    expect(record?.status).toBe('completed');
    expect(record?.resultSummary).toBe('done summary');

    store.ensureRecord(spawn());
    record = store.get('agent-1');
    expect(record?.status).toBe('running');
    expect(record?.resultSummary).toBeUndefined();

    store.markFailed('agent-1', 'boom');
    record = store.get('agent-1');
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('boom');
  });

  it('clear() releases all records', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: 0 }));
    store.clear();
    expect(store.get('agent-1')).toBeUndefined();
  });

  it('drop() removes one record along with its streaming buffers', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.ensureRecord(spawn({ agentId: 'agent-2', agentName: 'general' }));
    store.applyEvent(
      ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 't1', name: 'Write', argumentsPart: '{"path":"a"}' }),
    );

    store.drop('agent-1');

    expect(store.get('agent-1')).toBeUndefined();
    expect(store.get('agent-2')).toBeDefined();
    const buffers = (
      store as unknown as { streamingArgs: Map<string, string> }
    ).streamingArgs;
    expect([...buffers.keys()].every((key) => !key.startsWith('agent-1:'))).toBe(true);
  });

  it('caps long string argument values retained in a record', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 't1',
        name: 'Write',
        args: { path: 'a.ts', content: 'c'.repeat(SUBAGENT_ARG_STRING_MAX_CHARS + 500) },
      }),
    );
    const call = store.get('agent-1')?.steps[0]?.toolCalls[0];
    expect(typeof call?.args['content']).toBe('string');
    expect((call?.args['content'] as string).length).toBeLessThanOrEqual(
      SUBAGENT_ARG_STRING_MAX_CHARS + 1,
    );
    expect(call?.args['path']).toBe('a.ts');
  });

  it('drops delta-only arg buffers when their step is evicted', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    // A call truncated before started/result only ever produced deltas.
    store.applyEvent(
      ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 't-trunc', name: 'Write', argumentsPart: '{"path":"a"' }),
    );
    const buffers = (
      store as unknown as { streamingArgs: Map<string, string> }
    ).streamingArgs;
    expect(buffers.has('agent-1:t-trunc')).toBe(true);

    for (let i = 0; i < MAX_SUBAGENT_ACTIVITY_STEPS; i++) {
      store.applyEvent(ev({ type: 'turn.step.started', turnId: 1, step: i }));
    }
    expect(buffers.has('agent-1:t-trunc')).toBe(false);
  });

  it('drops leftover arg buffers when the record turns terminal', () => {
    const store = new SubagentActivityStore();
    store.ensureRecord(spawn());
    store.applyEvent(
      ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 't-trunc', name: 'Write', argumentsPart: '{"path":"a"' }),
    );
    const buffers = (
      store as unknown as { streamingArgs: Map<string, string> }
    ).streamingArgs;
    expect(buffers.has('agent-1:t-trunc')).toBe(true);

    store.markCompleted('agent-1', 'done');
    expect(buffers.has('agent-1:t-trunc')).toBe(false);
  });
});
