// apps/kimi-web/test/compaction.test.ts
//
// Compaction events stream through the REAL pipeline — projector → reducer —
// and surface as per-session compaction status ("compacting…" notice while
// running) plus a persistent divider marker message on completion. The
// scrollback is never reloaded/replaced.

import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import { createInitialState, reduceAppEvent, type KimiClientState } from '../src/api/daemon/eventReducer';
import { COMPACTION_MARKER_METADATA_KEY, type AppEvent } from '../src/api/types';

const SESSION = 'sess_1';

function play(events: [string, unknown][]): { state: KimiClientState; appEvents: AppEvent[] } {
  const projector = createAgentProjector();
  let state = createInitialState();
  // The session transcript is loaded (the marker is only appended then).
  state = { ...state, messagesBySession: { [SESSION]: [] } };
  const appEvents: AppEvent[] = [];
  let seq = 0;
  for (const [type, payload] of events) {
    for (const appEvent of projector.project(type, payload, SESSION)) {
      appEvents.push(appEvent);
      state = reduceAppEvent(state, appEvent, { sessionId: SESSION, seq: ++seq });
    }
  }
  return { state, appEvents };
}

describe('compaction pipeline', () => {
  it('compaction.started marks the session as compacting', () => {
    const { state } = play([
      ['compaction.started', { trigger: 'manual', instruction: 'keep recent work' }],
    ]);
    expect(state.compactionBySession[SESSION]).toEqual({
      status: 'running',
      trigger: 'manual',
    });
  });

  it('compaction.completed clears the running status and appends a divider marker', () => {
    const { state, appEvents } = play([
      ['compaction.started', { trigger: 'auto' }],
      ['compaction.completed', { result: { summary: 's', compactedCount: 12, tokensBefore: 90000, tokensAfter: 12000 } }],
    ]);

    // Running status is gone — completion is the marker, not transient status.
    expect(state.compactionBySession[SESSION]).toBeUndefined();

    const msgs = state.messagesBySession[SESSION] ?? [];
    const marker = msgs[msgs.length - 1];
    expect(marker?.metadata?.['origin']).toEqual({ kind: 'compaction_summary' });
    expect(marker?.metadata?.[COMPACTION_MARKER_METADATA_KEY]).toEqual({
      trigger: 'auto',
      tokensBefore: 90000,
      tokensAfter: 12000,
    });
    expect(marker?.content).toEqual([{ type: 'text', text: 's' }]);

    // The historyCompacted signal still fires (seq bookkeeping); the client
    // wrapper must NOT route compaction reasons to a snapshot reload.
    expect(appEvents.some((e) => e.type === 'historyCompacted')).toBe(true);
  });

  it('compaction.cancelled clears the compacting state', () => {
    const { state } = play([
      ['compaction.started', { trigger: 'manual' }],
      ['compaction.cancelled', {}],
    ]);
    expect(state.compactionBySession[SESSION]).toBeUndefined();
  });

  it('a completed event without a prior started still appends a marker', () => {
    const { state } = play([
      ['compaction.completed', { result: { summary: 's', compactedCount: 3, tokensBefore: 50000, tokensAfter: 8000 } }],
    ]);
    expect(state.compactionBySession[SESSION]).toBeUndefined();
    const msgs = state.messagesBySession[SESSION] ?? [];
    expect(msgs[msgs.length - 1]?.metadata?.[COMPACTION_MARKER_METADATA_KEY]).toMatchObject({
      trigger: 'auto',
      tokensBefore: 50000,
      tokensAfter: 8000,
    });
  });
});
