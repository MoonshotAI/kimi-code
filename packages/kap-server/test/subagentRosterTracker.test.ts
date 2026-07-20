/**
 * `SubagentRosterTracker` — live subagent roster for snapshot rebuilds.
 */

import type { Event } from '../src/transport/ws/v1/events';
import { describe, expect, it } from 'vitest';

import { SubagentRosterTracker } from '../src/transport/ws/v1/subagentRosterTracker';

const SID = 'sess_1';

function ev(partial: Record<string, unknown>): Event {
  return { agentId: 'main', sessionId: SID, ...partial } as unknown as Event;
}

function spawn(subagentId: string, extra: Record<string, unknown> = {}): Event {
  return ev({
    type: 'subagent.spawned',
    subagentId,
    subagentName: 'kimi-subagent',
    parentToolCallId: 'tc_swarm_1',
    description: `task ${subagentId}`,
    swarmIndex: 0,
    runInBackground: false,
    ...extra,
  });
}

describe('SubagentRosterTracker', () => {
  it('seeds a roster entry from subagent.spawned with the swarm identity metadata', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { swarmIndex: 2 }));

    expect(t.get(SID)).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        session_id: SID,
        kind: 'subagent',
        description: 'task agent-1',
        status: 'running',
        subagent_phase: 'queued',
        subagent_type: 'kimi-subagent',
        parent_tool_call_id: 'tc_swarm_1',
        swarm_index: 2,
        run_in_background: false,
      }),
    ]);
  });

  it('treats an empty parentToolCallId as absent', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { parentToolCallId: '' }));
    expect(t.get(SID)[0]?.parent_tool_call_id).toBeUndefined();
  });

  it('skips background subagents — REST /tasks already serves them after a refresh', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1', { runInBackground: true }));
    expect(t.get(SID)).toEqual([]);
  });

  it('drops the entry when a foreground subagent detaches into a background task', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));

    const taskStarted = (detached: boolean): Event =>
      ev({
        type: 'task.started',
        info: {
          taskId: 'task_1',
          kind: 'agent',
          agentId: 'agent-1',
          detached,
          description: 'task agent-1',
          status: 'running',
          startedAt: 1,
          endedAt: null,
        },
      });

    // A still-foreground registration (not detached) must keep the entry.
    t.apply(SID, taskStarted(false));
    expect(t.get(SID)).toHaveLength(1);

    // The detach transition hands the subagent to REST /tasks — drop the row.
    t.apply(SID, taskStarted(true));
    expect(t.get(SID)).toEqual([]);
  });

  it('follows the subagent phase transitions', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1' }));
    expect(t.get(SID)[0]).toMatchObject({ subagent_phase: 'working' });
    expect(t.get(SID)[0]?.started_at).toBeDefined();

    t.apply(
      SID,
      ev({ type: 'subagent.suspended', subagentId: 'agent-1', reason: 'rate limit' }),
    );
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'suspended',
      suspended_reason: 'rate limit',
    });

    // A resumed subagent re-fires started; the original started_at is kept.
    const startedAt = t.get(SID)[0]?.started_at;
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'agent-1' }));
    expect(t.get(SID)[0]).toMatchObject({ subagent_phase: 'working', started_at: startedAt });
    expect(t.get(SID)[0]?.suspended_reason).toBeUndefined();

    t.apply(
      SID,
      ev({ type: 'subagent.completed', subagentId: 'agent-1', resultSummary: 'done' }),
    );
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'completed',
      status: 'completed',
      output_preview: 'done',
    });
    expect(t.get(SID)[0]?.completed_at).toBeDefined();
  });

  it('marks failures with the error preview', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    t.apply(SID, ev({ type: 'subagent.failed', subagentId: 'agent-1', error: 'boom' }));
    expect(t.get(SID)[0]).toMatchObject({
      subagent_phase: 'failed',
      status: 'failed',
      output_preview: 'boom',
    });
  });

  it('clears the roster on the next MAIN turn.started, not on any turn.ended', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));

    // A swarm member's own turn.ended flows through the same session queue and
    // must not drop the roster mid-swarm.
    t.apply(SID, ev({ type: 'turn.ended', agentId: 'agent-1', turnId: 1 }));
    expect(t.get(SID)).toHaveLength(1);

    // The main turn.ended must not drop the roster either: the swarm result
    // may still be queued behind the async wire append, and a refresh in that
    // window would otherwise lose the member list.
    t.apply(SID, ev({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' }));
    expect(t.get(SID)).toHaveLength(1);

    // The next main turn.started settles the previous transcript — safe to drop.
    t.apply(SID, ev({ type: 'turn.started', agentId: 'main', turnId: 2 }));
    expect(t.get(SID)).toEqual([]);
  });

  it('finalizes still-live entries when the main turn aborts', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    t.apply(SID, spawn('agent-2'));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'agent-2', resultSummary: 'done' }));

    // The abort path suppresses the members' own subagent.failed events, so
    // the tracker must settle them itself.
    t.apply(SID, ev({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled' }));

    const entries = t.get(SID);
    expect(entries[0]).toMatchObject({
      id: 'agent-1',
      status: 'failed',
      subagent_phase: 'failed',
      output_preview: 'Main turn cancelled',
    });
    expect(entries[0]?.completed_at).toBeDefined();
    // Already-terminal entries are left untouched.
    expect(entries[1]).toMatchObject({ id: 'agent-2', status: 'completed', output_preview: 'done' });
  });

  it('ignores lifecycle events for unknown subagents', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, ev({ type: 'subagent.started', subagentId: 'ghost' }));
    t.apply(SID, ev({ type: 'subagent.completed', subagentId: 'ghost', resultSummary: 'x' }));
    expect(t.get(SID)).toEqual([]);
  });

  it('returns fresh copies that callers cannot mutate back into the tracker', () => {
    const t = new SubagentRosterTracker();
    t.apply(SID, spawn('agent-1'));
    const first = t.get(SID);
    first[0]!.description = 'mutated';
    expect(t.get(SID)[0]?.description).toBe('task agent-1');
  });
});
