import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import type { AppEvent } from '../src/api/types';

// Reproduce the "after one ws disconnect, streaming only shows whole blocks"
// bug at the projector layer. The projector survives reconnects and session
// switches (it is created once per connectEvents / page load), so any state it
// corrupts on reconnect stays broken until a full reload.

function deltas(events: AppEvent[]): string[] {
  return events
    .filter((e): e is Extract<AppEvent, { type: 'assistantDelta' }> => e.type === 'assistantDelta')
    .map((e) => e.delta.text ?? e.delta.thinking ?? '');
}

function hasResync(events: AppEvent[]): boolean {
  return events.some((e) => e.type === 'historyCompacted');
}

describe('reconnect streaming recovery (projector)', () => {
  it('streams a normal turn delta-by-delta', () => {
    const p = createAgentProjector();
    const sid = 'sess_1';
    p.project('turn.started', { turnId: 1 }, sid);
    p.project('turn.step.started', { turnId: 1 }, sid);
    const a = p.project('assistant.delta', { delta: 'Hel' }, sid, { offset: 0 });
    const b = p.project('assistant.delta', { delta: 'lo ' }, sid, { offset: 3 });
    const c = p.project('assistant.delta', { delta: 'wor' }, sid, { offset: 6 });
    expect(deltas([...a, ...b, ...c])).toEqual(['Hel', 'lo ', 'wor']);
  });

  it('a NEW turn after a mid-turn reconnect (no resync) still streams', () => {
    const p = createAgentProjector();
    const sid = 'sess_1';

    // ---- Turn 1 streams up to offset 9, then ws drops (deltas 9..40 lost) ----
    p.project('turn.started', { turnId: 1 }, sid);
    p.project('turn.step.started', { turnId: 1 }, sid);
    p.project('assistant.delta', { delta: 'aaaaaaaaa' }, sid, { offset: 0 }); // turnTextLen -> 9

    // ws drops. Daemon keeps streaming turn 1 to assistantText length 40, then
    // the step + turn complete DURING the disconnect. On reconnect the durable
    // tail is replayed (deltas are volatile => NOT replayed). The cursor is
    // still servable, so NO resync_required fires.
    const completed = p.project('turn.step.completed', { turnId: 1, usage: {} }, sid);
    const ended = p.project('turn.ended', { turnId: 1, reason: 'completed' }, sid);
    expect(hasResync([...completed, ...ended])).toBe(false);

    // ---- Turn 2 (brand new prompt) after reconnect ----
    // Daemon resets assistantText=0 for turn 2; first delta offset 0.
    p.project('turn.started', { turnId: 2 }, sid);
    p.project('turn.step.started', { turnId: 2 }, sid);
    const d1 = p.project('assistant.delta', { delta: 'Hi ' }, sid, { offset: 0 });
    const d2 = p.project('assistant.delta', { delta: 'there' }, sid, { offset: 3 });

    // BUG would show as these being skipped (empty) because turnTextLen is stale.
    expect(deltas([...d1, ...d2])).toEqual(['Hi ', 'there']);
  });

  it('a new turn whose turn.started was missed on reconnect still streams', () => {
    // The real failure mode: after a reconnect the durable replay and the live
    // volatile deltas race on the cursor, so turn 2's `turn.started` is not
    // re-delivered to the projector, but turn 2's deltas (offset 0,1,2…) are.
    // If turn.ended left turnTextLen stale at turn 1's length, every turn-2
    // delta has offset < turnTextLen and is SILENTLY skipped (skip has no
    // recovery, unlike gap) — streaming dies until a full page reload.
    const p = createAgentProjector();
    const sid = 'sess_1';

    // Turn 1 streams 50 chars then ends.
    p.project('turn.started', { turnId: 1 }, sid);
    p.project('turn.step.started', { turnId: 1 }, sid);
    p.project('assistant.delta', { delta: 'a'.repeat(50) }, sid, { offset: 0 });
    p.project('turn.step.completed', { turnId: 1, usage: {} }, sid);
    p.project('turn.ended', { turnId: 1, reason: 'completed' }, sid);

    // Turn 2 — turn.started MISSED (race), but a step.started + live deltas land.
    p.project('turn.step.started', { turnId: 2 }, sid);
    const d1 = p.project('assistant.delta', { delta: 'Hi ' }, sid, { offset: 0 });
    const d2 = p.project('assistant.delta', { delta: 'there' }, sid, { offset: 3 });

    expect(deltas([...d1, ...d2])).toEqual(['Hi ', 'there']);
  });

  it('reconnect WITHIN turn 1 (durable step.started replay) keeps streaming', () => {
    const p = createAgentProjector();
    const sid = 'sess_1';

    p.project('turn.started', { turnId: 1 }, sid);
    p.project('turn.step.started', { turnId: 1 }, sid);
    p.project('assistant.delta', { delta: 'aaaaaaaaa' }, sid, { offset: 0 }); // len 9

    // ws drops mid-step-1. Daemon streams to 40, step 1 completes, step 2
    // starts (durable). On reconnect those durable events replay.
    p.project('turn.step.completed', { turnId: 1, usage: {} }, sid);
    p.project('turn.step.started', { turnId: 1 }, sid); // new assistant msg, turnTextLen NOT reset

    // Live deltas of step 2 resume. Daemon assistantText is cumulative across
    // steps -> offset continues from 40.
    const r = p.project('assistant.delta', { delta: 'X' }, sid, { offset: 40 });
    // offset 40 > turnTextLen 9 -> should detect a gap and request resync.
    expect(hasResync(r)).toBe(true);
  });
});
