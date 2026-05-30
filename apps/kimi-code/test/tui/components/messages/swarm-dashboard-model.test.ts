import { describe, expect, it } from 'vitest';

import {
  applySwarmEvent,
  initialSwarmModel,
  workerActivityFromTool,
  type SwarmModel,
} from '#/tui/components/messages/swarm-dashboard-model';

function reduce(events: Parameters<typeof applySwarmEvent>[1][]): SwarmModel {
  return events.reduce((m, e) => applySwarmEvent(m, e), initialSwarmModel('do a task'));
}

describe('swarm failed phase', () => {
  it('sets the failed phase and stores the failure message', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'failed', message: 'planner exploded' },
    ]);
    expect(m.phase).toBe('failed');
    expect(m.failureMessage).toBe('planner exploded');
  });
});

describe('applySwarmEvent', () => {
  it('starts in planning phase with the task', () => {
    const m = initialSwarmModel('my task');
    expect(m.task).toBe('my task');
    expect(m.phase).toBe('planning');
    expect(m.workers.size).toBe(0);
  });

  it('planned sets total and moves to working', () => {
    const m = reduce([{ t: 'planned', total: 5 }]);
    expect(m.phase).toBe('working');
    expect(m.total).toBe(5);
  });

  it('builds a worker row on spawn and tracks activity + count', () => {
    const m = reduce([
      { t: 'planned', total: 2 },
      { t: 'worker.spawned', id: 'a1', role: 'Researcher' },
      { t: 'worker.toolcall', id: 'a1', activity: 'read foo.ts' },
      { t: 'worker.toolcall', id: 'a1', activity: 'grep "x"' },
    ]);
    const w = m.workers.get('a1');
    expect(w?.role).toBe('Researcher');
    expect(w?.status).toBe('running');
    expect(w?.toolCount).toBe(2);
    expect(w?.latestActivity).toBe('grep "x"');
  });

  it('marks workers done/failed and counts them', () => {
    const m = reduce([
      { t: 'planned', total: 2 },
      { t: 'worker.spawned', id: 'a1', role: 'R' },
      { t: 'worker.spawned', id: 'a2', role: 'A' },
      { t: 'worker.done', id: 'a1', tokens: 2100 },
      { t: 'worker.failed', id: 'a2', error: 'timeout' },
    ]);
    expect(m.workers.get('a1')?.status).toBe('done');
    expect(m.workers.get('a1')?.tokens).toBe(2100);
    expect(m.workers.get('a2')?.status).toBe('failed');
    expect(m.workers.get('a2')?.error).toBe('timeout');
    expect(m.doneCount).toBe(1);
    expect(m.failedCount).toBe(1);
  });

  it('synthesizing then done set the phase', () => {
    const m = reduce([{ t: 'planned', total: 1 }, { t: 'synthesizing' }, { t: 'done', succeeded: 1, failed: 0 }]);
    expect(m.phase).toBe('done');
  });

  it('cancelled sets the phase', () => {
    const m = reduce([{ t: 'planned', total: 1 }, { t: 'cancelled' }]);
    expect(m.phase).toBe('cancelled');
  });

  it('clamps a worker that finishes without an explicit running transition', () => {
    const m = reduce([{ t: 'worker.spawned', id: 'a1', role: 'R' }, { t: 'worker.done', id: 'a1' }]);
    expect(m.workers.get('a1')?.status).toBe('done');
  });

  it('worker.tokens updates a running worker tokens without touching count/status/activity', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'Researcher' },
      { t: 'worker.toolcall', id: 'a1', activity: 'read foo.ts' },
      { t: 'worker.tokens', id: 'a1', tokens: 3200 },
    ]);
    const w = m.workers.get('a1');
    expect(w?.tokens).toBe(3200);
    expect(w?.status).toBe('running');
    expect(w?.toolCount).toBe(1);
    expect(w?.latestActivity).toBe('read foo.ts');
  });

  it('worker.tokens is a no-op for an unknown worker id', () => {
    const before = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'R' },
    ]);
    const after = applySwarmEvent(before, { t: 'worker.tokens', id: 'ghost', tokens: 999 });
    expect(after).toBe(before);
    expect(after.workers.get('ghost')).toBeUndefined();
  });

  it('worker.retrying sets the matching role row to retrying and keeps it visible', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'Worker' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.retrying', role: 'Worker' },
    ]);
    expect(m.workers.size).toBe(1);
    expect(m.workers.get('a1')?.status).toBe('retrying');
  });

  it('a worker.spawned for a role already retrying REUSES the row (no duplicate, id updated, running)', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'Worker' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.retrying', role: 'Worker' },
      { t: 'worker.spawned', id: 'a2', role: 'Worker' },
    ]);
    // Exactly one row for the role, now keyed by the NEW subagent id, reset to running.
    expect(m.workers.size).toBe(1);
    expect(m.workers.get('a1')).toBeUndefined();
    const w = m.workers.get('a2');
    expect(w?.role).toBe('Worker');
    expect(w?.status).toBe('running');
    expect(w?.error).toBeUndefined();
  });

  it('a worker.spawned for a role in a terminal failed state REUSES the row on retry', () => {
    // Even without an explicit worker.retrying, a re-spawn of the same role
    // collapses onto the existing terminal row (one row per role across attempts).
    const m = reduce([
      { t: 'worker.spawned', id: 'a1', role: 'Worker' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.spawned', id: 'a2', role: 'Worker' },
    ]);
    expect(m.workers.size).toBe(1);
    expect(m.workers.get('a2')?.status).toBe('running');
  });

  it('worker.dropped sets an existing role row to dropped with the reason', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'Worker' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.dropped', role: 'Worker', reason: 'impossible' },
    ]);
    expect(m.workers.size).toBe(1);
    const w = m.workers.get('a1');
    expect(w?.status).toBe('dropped');
    expect(w?.error).toBe('impossible');
  });

  it('worker.dropped creates a dropped row when the subtask never spawned a worker', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.dropped', role: 'Planner', reason: 'no decision' },
    ]);
    expect(m.workers.size).toBe(1);
    const w = [...m.workers.values()][0];
    expect(w?.role).toBe('Planner');
    expect(w?.status).toBe('dropped');
    expect(w?.error).toBe('no decision');
  });

  it('distinct roles still get distinct rows; same-role reuse does not collapse them', () => {
    const m = reduce([
      { t: 'planned', total: 2 },
      { t: 'worker.spawned', id: 'a1', role: 'Researcher' },
      { t: 'worker.spawned', id: 'a2', role: 'Analyst' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.retrying', role: 'Researcher' },
      { t: 'worker.spawned', id: 'a3', role: 'Researcher' },
    ]);
    expect(m.workers.size).toBe(2);
    expect(m.workers.get('a3')?.role).toBe('Researcher');
    expect(m.workers.get('a2')?.role).toBe('Analyst');
  });

  it('a reassign (new role) re-spawn adds a new row (does not reuse a different role)', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'Worker' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.retrying', role: 'Worker' },
      { t: 'worker.spawned', id: 'a2', role: 'R2' },
    ]);
    expect(m.workers.size).toBe(2);
    expect(m.workers.get('a1')?.role).toBe('Worker');
    expect(m.workers.get('a2')?.role).toBe('R2');
  });

  it('reassign collapses to ONE row: failed(OLD) -> reassigned(OLD->NEW) -> spawned(NEW) -> done', () => {
    // The reassign-orphan regression: before the fix, a reassign marked the OLD
    // role row retrying then the re-spawn created a NEW role row, stranding the
    // old one in 'retrying' forever. The reassigned event re-keys the SAME row.
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'OldRole' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.reassigned', fromRole: 'OldRole', toRole: 'NewRole' },
      { t: 'worker.spawned', id: 'a2', role: 'NewRole' },
      { t: 'worker.done', id: 'a2', tokens: 1500 },
    ]);
    // Exactly one row, final role NewRole, status done.
    expect(m.workers.size).toBe(1);
    const w = [...m.workers.values()][0];
    expect(w?.role).toBe('NewRole');
    expect(w?.status).toBe('done');
    expect(w?.tokens).toBe(1500);
    // No row left dangling in 'retrying', and no stray OldRole row.
    expect([...m.workers.values()].some((r) => r.status === 'retrying')).toBe(false);
    expect([...m.workers.values()].some((r) => r.role === 'OldRole')).toBe(false);
    expect(m.doneCount).toBe(1);
    expect(m.failedCount).toBe(0);
  });

  it('worker.reassigned re-keys the failed row to the new role and marks it retrying', () => {
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'OldRole' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.reassigned', fromRole: 'OldRole', toRole: 'NewRole' },
    ]);
    expect(m.workers.size).toBe(1);
    const w = m.workers.get('a1');
    expect(w?.role).toBe('NewRole');
    expect(w?.status).toBe('retrying');
    expect(w?.error).toBeUndefined();
    // The transient failed count is reversed when the row leaves the failed state.
    expect(m.failedCount).toBe(0);
  });

  it('worker.reassigned is a no-op when no fromRole row exists', () => {
    const before = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'Other' },
    ]);
    const after = applySwarmEvent(before, {
      t: 'worker.reassigned',
      fromRole: 'Missing',
      toRole: 'NewRole',
    });
    expect(after).toBe(before);
  });

  it('full failed->retrying->respawn(running)->done on ONE role keeps counts consistent', () => {
    // Locks count bookkeeping: the transient failed must be reversed, so the
    // surviving row is done and the failed/dropped counts return to zero.
    const m = reduce([
      { t: 'planned', total: 1 },
      { t: 'worker.spawned', id: 'a1', role: 'Worker' },
      { t: 'worker.failed', id: 'a1', error: 'boom' },
      { t: 'worker.retrying', role: 'Worker' },
      { t: 'worker.spawned', id: 'a2', role: 'Worker' },
      { t: 'worker.done', id: 'a2', tokens: 900 },
    ]);
    expect(m.workers.size).toBe(1);
    const w = [...m.workers.values()][0];
    expect(w?.status).toBe('done');
    expect(m.doneCount).toBe(1);
    expect(m.failedCount).toBe(0);
    expect(m.droppedCount).toBe(0);
  });

  it('single-run (no retry) leaves running rows untouched by reuse logic', () => {
    const m = reduce([
      { t: 'planned', total: 2 },
      { t: 'worker.spawned', id: 'a1', role: 'Researcher' },
      { t: 'worker.spawned', id: 'a2', role: 'Researcher' },
    ]);
    // Two concurrent running workers of the same role keep distinct rows; reuse
    // only applies to terminal/retrying rows, so single-run fan-out is unchanged.
    expect(m.workers.size).toBe(2);
  });
});

describe('workerActivityFromTool', () => {
  it('formats common tools compactly', () => {
    expect(workerActivityFromTool('Read', { path: 'a/b.ts' })).toBe('read a/b.ts');
    expect(workerActivityFromTool('Grep', { pattern: 'foo' })).toBe('grep "foo"');
    expect(workerActivityFromTool('Glob', { pattern: '*.ts' })).toBe('glob *.ts');
    expect(workerActivityFromTool('WebSearch', { query: 'kimi' })).toBe('search "kimi"');
    expect(workerActivityFromTool('FetchURL', { url: 'http://x' })).toBe('fetch http://x');
  });
  it('falls back to the tool name', () => {
    expect(workerActivityFromTool('Mystery', {})).toBe('Mystery');
  });
});
