/**
 * Audit-layer tests: the trail recorder, the structural diff, serialization,
 * and tail-preserving truncation used by the chat view's audit panel.
 */

import type { StepMessage, TurnMessage } from '@moonshot-ai/kap-server/protocol';
import { describe, expect, it } from 'vitest';

import { EMPTY_CHAT_STATE, type ChatState } from '../transcript/store';
import { diffValue, type DiffNode } from './diff';
import { serializeState } from './serialize';
import { AuditTrail, AUDIT_TRAIL_MAX_ENTRIES } from './trail';
import { tailTrunc } from './truncate';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
let tick = 0;

function ts(): string {
  tick += 1;
  return new Date(T0 + tick * 1000).toISOString();
}

function turnMsg(n: number, state: 'running' | 'completed' = 'completed'): TurnMessage {
  return {
    type: 'turn',
    session_id: 's1',
    agent_id: 'main',
    timestamp: ts(),
    turn_id: `t${n}`,
    ordinal: n,
    state,
    origin: { kind: 'user' },
  };
}

function stepMsg(stepId: string, state: 'running' | 'completed'): StepMessage {
  return {
    type: 'step',
    session_id: 's1',
    agent_id: 'main',
    timestamp: ts(),
    step_id: stepId,
    turn_id: stepId.split('.')[0] ?? 't1',
    ordinal: Number(stepId.split('.')[1] ?? '1'),
    state,
  };
}

function stateWithTimeline(items: readonly (TurnMessage | StepMessage)[]): ChatState {
  return {
    ...EMPTY_CHAT_STATE,
    entries: items.map((message) => ({
      key: message.type === 'turn' ? `turn:${message.turn_id}` : `step:${message.step_id}`,
      message,
    })),
  };
}

// ---------------------------------------------------------------- diff

describe('diffValue', () => {
  it('collapses reference-equal subtrees to unchanged without children', () => {
    const shared = { a: 1, b: { c: 'x' } };
    const node = diffValue({ v: shared }, { v: shared });
    expect(node.status).toBe('unchanged');
    expect(node.children?.get('v')?.children).toBeUndefined();
  });

  it('marks added, removed, and modified object keys', () => {
    const node = diffValue(
      { keep: 1, gone: 'x', changed: 'a' },
      { keep: 1, fresh: true, changed: 'b' },
    );
    expect(node.status).toBe('modified');
    expect(node.children?.get('keep')?.status).toBe('unchanged');
    expect(node.children?.get('fresh')?.status).toBe('added');
    expect(node.children?.get('gone')).toMatchObject({ status: 'removed', prev: 'x' });
    expect(node.children?.get('changed')).toMatchObject({
      status: 'modified',
      prev: 'a',
      value: 'b',
    });
  });

  it('matches entity arrays by id instead of index', () => {
    const t1 = turnMsg(1);
    const t2 = turnMsg(2);
    const prev = [t1, t2];
    const next = [t1, { ...t2, state: 'running' as const }, turnMsg(3)];
    const node = diffValue(prev, next);
    expect(node.children?.get('t1')?.status).toBe('unchanged');
    expect(node.children?.get('t2')?.status).toBe('modified');
    expect(node.children?.get('t2')?.children?.get('state')).toMatchObject({
      status: 'modified',
      prev: 'completed',
      value: 'running',
    });
    expect(node.children?.get('t3')?.status).toBe('added');
  });

  it('keys steps by step_id (not their shared turn_id) so siblings never collide', () => {
    const done = stepMsg('t1.1', 'completed');
    const node = diffValue(
      [done, stepMsg('t1.2', 'completed')],
      [done, stepMsg('t1.2', 'running')],
    );
    expect([...(node.children?.keys() ?? [])]).toEqual(['t1.1', 't1.2']);
    expect(node.children?.get('t1.1')?.status).toBe('unchanged');
    expect(node.children?.get('t1.2')?.status).toBe('modified');
  });

  it('marks removed array elements by id', () => {
    const t2 = turnMsg(2);
    const node = diffValue([turnMsg(1), t2], [t2]);
    expect(node.children?.get('t1')).toMatchObject({ status: 'removed' });
    expect(node.children?.get('t2')?.status).toBe('unchanged');
  });

  it('marks whole-subtree adds/removes without descending', () => {
    const added = diffValue(undefined, { nested: { deep: 1 } });
    expect(added.status).toBe('added');
    expect(added.children).toBeUndefined();
    const removed = diffValue({ nested: 1 }, undefined);
    expect(removed.status).toBe('removed');
    expect(removed.children).toBeUndefined();
  });

  it('treats type changes as leaf modifications', () => {
    expect(diffValue('1', 1).status).toBe('modified');
    expect(diffValue(null, {}).status).toBe('modified');
    expect(diffValue([1], { 0: 1 }).status).toBe('modified');
  });

  it('diffs two serialized states with session.state changes visible', () => {
    const base = stateWithTimeline([turnMsg(1)]);
    const prev = serializeState(base);
    const nextState: ChatState = {
      ...base,
      sessionState: {
        type: 'session.state',
        session_id: 's1',
        timestamp: ts(),
        busy: true,
        main_turn_active: true,
        activity: 'turn',
        goal: { objective: 'ship it', status: 'active' },
        modes: { plan: { review_path: '/tmp/plan.md' } },
      },
    };
    const node: DiffNode = diffValue(prev, serializeState(nextState));
    expect(node.children?.get('timeline')?.status).toBe('unchanged');
    const sessionState = node.children?.get('sessionState');
    expect(sessionState?.status).toBe('added');
    expect(sessionState?.children).toBeUndefined();
  });
});

// ---------------------------------------------------------------- serialize

describe('serializeState', () => {
  it('turns maps into sorted plain objects and flattens the timeline', () => {
    const state: ChatState = {
      ...EMPTY_CHAT_STATE,
      entries: stateWithTimeline([turnMsg(1)]).entries,
      tasks: new Map([
        [
          'b-task',
          {
            type: 'task',
            session_id: 's1',
            agent_id: 'main',
            timestamp: ts(),
            task_id: 'b-task',
            kind: 'shell',
            state: 'running',
            detached: false,
            output_tail: '',
          },
        ],
        [
          'a-task',
          {
            type: 'task',
            session_id: 's1',
            agent_id: 'main',
            timestamp: ts(),
            task_id: 'a-task',
            kind: 'tool',
            state: 'completed',
            detached: false,
            output_tail: '',
          },
        ],
      ]),
    };
    const out = serializeState(state);
    expect(Object.keys(out.tasks)).toEqual(['a-task', 'b-task']);
    expect(out.timeline.map((m) => (m.type === 'turn' ? m.turn_id : ''))).toEqual(['t1']);
    expect(out.hasMoreOlder).toBe(false);
  });
});

// ---------------------------------------------------------------- truncate

describe('tailTrunc', () => {
  it('returns short strings unchanged', () => {
    expect(tailTrunc('hello')).toBe('hello');
    expect(tailTrunc('x'.repeat(500))).toBe('x'.repeat(500));
  });

  it('keeps the tail of long strings and reports the total length', () => {
    const value = 'head-padding'.repeat(100) + 'THE-TAIL';
    const out = tailTrunc(value, 50);
    expect(out).toContain(`${value.length} chars total`);
    expect(out.endsWith('THE-TAIL')).toBe(true);
    expect(out).not.toContain('head-padding'.repeat(10));
  });
});

// ---------------------------------------------------------------- trail

describe('AuditTrail', () => {
  it('records entries with increasing indices, timestamps, and state references', () => {
    const trail = new AuditTrail();
    const s1 = stateWithTimeline([turnMsg(1)]);
    const s2 = stateWithTimeline([turnMsg(1), turnMsg(2)]);
    trail.recordRest({ pageSize: 500 }, 'replace', 1, { turn_id: 't1', step_id: 't1.1' }, s1);
    trail.recordWs(turnMsg(2, 'running'), s2);
    trail.recordEvent('prompt', 'hello', s2);

    const entries = trail.getEntries();
    expect(entries.map((entry) => entry.kind)).toEqual(['rest', 'ws', 'event']);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(entries[0]!.state).toBe(s1);
    expect(entries[1]!.state).toBe(s2);
    expect(entries[0]).toMatchObject({ mode: 'replace', messageCount: 1 });
    expect(entries[2]).toMatchObject({ event: 'prompt', detail: 'hello' });
    expect(entries.every((entry) => typeof entry.at === 'string' && entry.at.length > 0)).toBe(
      true,
    );
    expect(entries.every((entry) => entry.summary.length > 0)).toBe(true);
  });

  it('notifies subscribers on each record', () => {
    const trail = new AuditTrail();
    let notified = 0;
    const unsubscribe = trail.subscribe(() => {
      notified += 1;
    });
    trail.recordEvent('cancel', undefined, EMPTY_CHAT_STATE);
    trail.recordEvent('ack', undefined, EMPTY_CHAT_STATE);
    expect(notified).toBe(2);
    unsubscribe();
    trail.recordEvent('reconnect', undefined, EMPTY_CHAT_STATE);
    expect(notified).toBe(2);
  });

  it('drops the oldest entries beyond the cap while indices keep increasing', () => {
    const trail = new AuditTrail();
    for (let i = 0; i < AUDIT_TRAIL_MAX_ENTRIES + 10; i += 1) {
      trail.recordEvent('prompt', `p${i}`, EMPTY_CHAT_STATE);
    }
    const entries = trail.getEntries();
    expect(entries).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES);
    expect(entries[0]!.index).toBe(10);
    expect(entries.at(-1)!.index).toBe(AUDIT_TRAIL_MAX_ENTRIES + 9);
  });
});
