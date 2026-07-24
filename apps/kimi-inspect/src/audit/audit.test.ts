/**
 * Audit-layer tests: the trail recorder, the structural diff, serialization,
 * and tail-preserving truncation used by the chat view's audit panel.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_AGENT_STATE,
  type AgentState,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';

import { diffValue, type DiffNode } from './diff';
import { serializeState } from './serialize';
import { AuditTrail, AUDIT_TRAIL_MAX_ENTRIES } from './trail';
import { tailTrunc } from './truncate';

function turnItem(n: number): TranscriptTurn {
  return { kind: 'turn', turnId: `t${n}`, ordinal: n, state: 'completed', origin: { kind: 'user' }, steps: [] };
}

function stateWith(items: readonly TranscriptTurn[]): AgentState {
  return { ...EMPTY_AGENT_STATE, items };
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
    const node = diffValue({ keep: 1, gone: 'x', changed: 'a' }, { keep: 1, fresh: true, changed: 'b' });
    expect(node.status).toBe('modified');
    expect(node.children?.get('keep')?.status).toBe('unchanged');
    expect(node.children?.get('fresh')?.status).toBe('added');
    expect(node.children?.get('gone')).toMatchObject({ status: 'removed', prev: 'x' });
    expect(node.children?.get('changed')).toMatchObject({ status: 'modified', prev: 'a', value: 'b' });
  });

  it('matches entity arrays by id instead of index', () => {
    const prev = [turnItem(1), turnItem(2)];
    const next = [turnItem(1), { ...turnItem(2), state: 'running' as const }, turnItem(3)];
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

  it('keys steps by stepId (not their shared turnId) so siblings never collide', () => {
    const step = (id: string, state: 'running' | 'completed') => ({
      kind: 'step' as const,
      stepId: id,
      turnId: 't1',
      ordinal: 1,
      state,
      frames: [],
    });
    const node = diffValue(
      [step('t1.1', 'completed'), step('t1.2', 'completed')],
      [step('t1.1', 'completed'), step('t1.2', 'running')],
    );
    expect([...node.children?.keys() ?? []]).toEqual(['t1.1', 't1.2']);
    expect(node.children?.get('t1.1')?.status).toBe('unchanged');
    expect(node.children?.get('t1.2')?.status).toBe('modified');
  });

  it('marks removed array elements by id', () => {
    const node = diffValue([turnItem(1), turnItem(2)], [turnItem(2)]);
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

  it('diffs two serialized states with meta changes visible (goal/plan fields)', () => {
    const prev = serializeState(stateWith([turnItem(1)]));
    const nextState: AgentState = {
      ...stateWith([turnItem(1)]),
      meta: {
        goal: { objective: 'ship it', status: 'active' },
        modes: { plan: { reviewPath: '/tmp/plan.md' } },
      },
    };
    const node: DiffNode = diffValue(prev, serializeState(nextState));
    expect(node.children?.get('items')?.status).toBe('unchanged');
    const meta = node.children?.get('meta');
    expect(meta?.status).toBe('modified');
    expect(meta?.children?.get('goal')?.status).toBe('added');
    // Whole-subtree add: `modes` was absent before, so the block (plan
    // included) is marked added without descending into children.
    expect(meta?.children?.get('modes')?.status).toBe('added');
    expect(meta?.children?.get('modes')?.children).toBeUndefined();
  });
});

// ---------------------------------------------------------------- serialize

describe('serializeState', () => {
  it('turns maps into sorted plain objects and sets into arrays', () => {
    const state: AgentState = {
      ...EMPTY_AGENT_STATE,
      tasks: new Map([
        ['b-task', { taskId: 'b-task', kind: 'shell', state: 'running', detached: false, outputTail: '' }],
        ['a-task', { taskId: 'a-task', kind: 'tool', state: 'completed', detached: false, outputTail: '' }],
      ]),
      pendingInteractions: new Set(['z', 'a']),
    };
    const out = serializeState(state);
    expect(Object.keys(out.tasks as Record<string, unknown>)).toEqual(['a-task', 'b-task']);
    expect(out.pendingInteractions).toEqual(['a', 'z']);
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
  const page = {
    items: [turnItem(1)],
    hasMoreOlder: false,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    meta: {},
    pendingInteractions: [],
  };

  it('records entries with increasing indices, timestamps, and state references', () => {
    const trail = new AuditTrail();
    const s1 = stateWith([turnItem(1)]);
    const s2 = stateWith([turnItem(1), turnItem(2)]);
    trail.recordRest({ pageSize: 30 }, 'replace', page, s1);
    trail.recordOps([{ op: 'turn.upsert', turn: turnItem(2) }], 'live', '2026-01-01T00:00:00Z', s2);
    trail.recordEvent('prompt', 'hello', s2);
    trail.recordReset(
      { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {} },
      false,
      undefined,
      s2,
    );

    const entries = trail.getEntries();
    expect(entries.map((entry) => entry.kind)).toEqual(['rest', 'ops', 'event', 'reset']);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(entries[0]!.state).toBe(s1);
    expect(entries[1]!.state).toBe(s2);
    expect(entries[1]).toMatchObject({ delivery: 'live', envelopeAt: '2026-01-01T00:00:00Z' });
    expect(entries[2]).toMatchObject({ event: 'prompt', detail: 'hello' });
    expect(entries.every((entry) => typeof entry.at === 'string' && entry.at.length > 0)).toBe(true);
    expect(entries.every((entry) => entry.summary.length > 0)).toBe(true);
  });

  it('notifies subscribers on each record', () => {
    const trail = new AuditTrail();
    let notified = 0;
    const unsubscribe = trail.subscribe(() => {
      notified += 1;
    });
    trail.recordEvent('cancel', undefined, EMPTY_AGENT_STATE);
    trail.recordEvent('gap', undefined, EMPTY_AGENT_STATE);
    expect(notified).toBe(2);
    unsubscribe();
    trail.recordEvent('resync', undefined, EMPTY_AGENT_STATE);
    expect(notified).toBe(2);
  });

  it('drops the oldest entries beyond the cap while indices keep increasing', () => {
    const trail = new AuditTrail();
    for (let i = 0; i < AUDIT_TRAIL_MAX_ENTRIES + 10; i += 1) {
      trail.recordEvent('prompt', `p${i}`, EMPTY_AGENT_STATE);
    }
    const entries = trail.getEntries();
    expect(entries).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES);
    expect(entries[0]!.index).toBe(10);
    expect(entries.at(-1)!.index).toBe(AUDIT_TRAIL_MAX_ENTRIES + 9);
  });
});
