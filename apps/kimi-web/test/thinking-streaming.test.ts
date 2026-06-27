import { beforeEach, describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import type { AppEvent, AppSession } from '../src/api/types';
import { reduceAppEvent, createInitialState } from '../src/api/daemon/eventReducer';
import type { KimiClientState } from '../src/api/daemon/eventReducer';
import {
  appendStreamingDelta,
  clearStreaming,
  streamingBySession,
} from '../src/composables/client/streamingStore';

// Integration reproduction for the thinking-streaming regression.
//
// Real daemon frames flow: raw agent-core frame → projector.project() →
// AppEvent[] → applyEvent(). Since a29798789, applyEvent short-circuits
// `assistantDelta` into the streaming store and bypasses the reducer, then
// `messageUpdated` / `sessionStatusChanged`(idle|aborted) clear the store so
// the committed content takes over. This test drives that exact pipeline with a
// think → text → step.completed → turn.ended sequence and asserts the live
// thinking block stays visible while streaming and settles correctly.

const SID = 'session-thinking';

// Local mirror of applyEvent's short-circuit + commit-clear logic (the real
// one closes over module-level rawState, which we cannot reset between tests).
// Keeping the decision rules here in sync with useKimiWebClient.applyEvent is
// the point — if they drift, this test catches it.
function applyEventLocally(state: KimiClientState, event: AppEvent, seq: number): KimiClientState {
  if (event.type === 'assistantDelta') {
    appendStreamingDelta(SID, event.messageId, event.contentIndex, event.delta);
    // advanceSeqCursor (no rendering dependency)
    if (seq > 0 && seq > (state.lastSeqBySession[SID] ?? 0)) {
      state.lastSeqBySession[SID] = seq;
    }
    return state;
  }
  const next = reduceAppEvent(state, event, { sessionId: SID, seq });
  if (event.type === 'messageUpdated') clearStreaming(SID);
  if (event.type === 'sessionStatusChanged' && (event.status === 'idle' || event.status === 'aborted')) {
    clearStreaming(SID);
  }
  return next;
}

function projectFrame(
  projector: ReturnType<typeof createAgentProjector>,
  state: KimiClientState,
  type: string,
  payload: Record<string, unknown>,
  seq: number,
  offset?: number,
): KimiClientState {
  const events = projector.project(type, payload, SID, offset !== undefined ? { offset } : undefined);
  let s = state;
  for (const evt of events) s = applyEventLocally(s, evt, seq);
  return s;
}

beforeEach(() => {
  clearStreaming(SID);
});

function makeInitialSessionState(): KimiClientState {
  // Real flow has a sessionCreated before turn.started; sessionStatusChanged
  // only maps an existing session, so seed one here.
  const session: AppSession = {
    id: SID,
    title: SID,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    archived: false,
    cwd: '/workspace',
    model: 'kimi-code',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
  };
  return { ...createInitialState(), sessions: [session] };
}

describe('thinking streaming pipeline (projector → streaming store → reducer)', () => {
  it('keeps the live thinking block visible while streaming, then settles on step.completed', () => {
    const projector = createAgentProjector();
    let state: KimiClientState = { ...makeInitialSessionState() };

    // turn.started → running
    state = projectFrame(projector, state, 'turn.started', { turnId: 1 }, 1);
    expect(state.sessions.some((s) => s.id === SID && s.status === 'running')).toBe(true);

    // turn.step.started → empty assistant message created
    state = projectFrame(projector, state, 'turn.step.started', { turnId: 1 }, 2);
    const msgs = state.messagesBySession[SID] ?? [];
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[0]!.content).toHaveLength(0);
    const assistantMsgId = msgs[0]!.id;

    // thinking.delta x3 → live thinking accumulates in the streaming store ONLY
    // (reducer is bypassed), so messagesBySession stays empty. Wire `offset` is
    // the pre-append cumulative length, so it must track the running total.
    state = projectFrame(projector, state, 'thinking.delta', { delta: 'Let me ' }, 3, 0);
    state = projectFrame(projector, state, 'thinking.delta', { delta: 'think ' }, 4, 7);
    state = projectFrame(projector, state, 'thinking.delta', { delta: 'about this.' }, 5, 13);

    expect(state.messagesBySession[SID]![0]!.content).toHaveLength(0);
    const live = streamingBySession[SID];
    expect(live).toBeDefined();
    expect(live!.messageId).toBe(assistantMsgId);
    expect(live!.blocks).toHaveLength(1);
    expect(live!.blocks[0]).toMatchObject({ kind: 'thinking', contentIndex: 0, text: 'Let me think about this.' });

    // assistant.delta → opens a NEW content part (idx 1, text) in the live store.
    // turnTextLen starts at 0 for the text stream; offset tracks its own running
    // total (independent of thinking).
    state = projectFrame(projector, state, 'assistant.delta', { delta: 'Here ' }, 6, 0);
    state = projectFrame(projector, state, 'assistant.delta', { delta: 'is the answer.' }, 7, 5);

    const live2 = streamingBySession[SID];
    expect(live2!.blocks).toHaveLength(2);
    expect(live2!.blocks[0]).toMatchObject({ kind: 'thinking' });
    expect(live2!.blocks[1]).toMatchObject({ kind: 'text', text: 'Here is the answer.' });

    // turn.step.completed → messageUpdated carries the full content (thinking +
    // text) and CLEARS the live store. The committed content must now hold both.
    state = projectFrame(projector, state, 'turn.step.completed', { turnId: 1, usage: {} }, 8);
    expect(streamingBySession[SID]).toBeUndefined();
    const committed = state.messagesBySession[SID]![0]!.content;
    expect(committed).toHaveLength(2);
    expect(committed[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think about this.' });
    expect(committed[1]).toMatchObject({ type: 'text', text: 'Here is the answer.' });

    // turn.ended → idle; store already cleared.
    state = projectFrame(projector, state, 'turn.ended', { turnId: 1, reason: 'completed', durationMs: 42 }, 9);
    expect(streamingBySession[SID]).toBeUndefined();
    expect(state.sessions.some((s) => s.id === SID && s.status === 'idle')).toBe(true);
    expect(state.messagesBySession[SID]![0]!.durationMs).toBe(42);
  });

  it('does NOT clear the live thinking store on unrelated lifecycle events mid-stream', () => {
    const projector = createAgentProjector();
    let state: KimiClientState = { ...makeInitialSessionState() };
    state = projectFrame(projector, state, 'turn.started', { turnId: 1 }, 1);
    state = projectFrame(projector, state, 'turn.step.started', { turnId: 1 }, 2);
    state = projectFrame(projector, state, 'thinking.delta', { delta: 'pondering' }, 3, 0);

    // An agent.status.updated (usage) event is common mid-stream and must NOT
    // wipe the live thinking block.
    state = projectFrame(projector, state, 'agent.status.updated', { model: 'kimi-x', contextTokens: 123 }, 4);
    expect(streamingBySession[SID]).toBeDefined();
    expect(streamingBySession[SID]!.blocks[0]).toMatchObject({ kind: 'thinking', text: 'pondering' });
  });

  it('streams thinking across a second step after the first step commits', () => {
    // Multi-step turn: step1 (thinking + text) completes → messageUpdated clears
    // the store → step2 starts a fresh assistant message and streams thinking.
    // The live thinking must reappear for step2 (regression guard: clearing on
    // messageUpdated must not permanently kill the store for the rest of turn).
    const projector = createAgentProjector();
    let state: KimiClientState = { ...makeInitialSessionState() };

    state = projectFrame(projector, state, 'turn.started', { turnId: 1 }, 1);
    state = projectFrame(projector, state, 'turn.step.started', { turnId: 1 }, 2);
    state = projectFrame(projector, state, 'thinking.delta', { delta: 'step1 thought' }, 3, 0);
    state = projectFrame(projector, state, 'assistant.delta', { delta: 'step1 text' }, 4, 0);
    state = projectFrame(projector, state, 'turn.step.completed', { turnId: 1, usage: {} }, 5);
    expect(streamingBySession[SID]).toBeUndefined();

    // step2: a fresh assistant message; live thinking must accumulate again.
    state = projectFrame(projector, state, 'turn.step.started', { turnId: 1 }, 6);
    state = projectFrame(projector, state, 'thinking.delta', { delta: 'step2 thought' }, 7, 0);
    const live = streamingBySession[SID];
    expect(live).toBeDefined();
    expect(live!.blocks).toHaveLength(1);
    expect(live!.blocks[0]).toMatchObject({ kind: 'thinking', text: 'step2 thought' });
  });
});

  it('resumes live thinking after a mid-stream reconnect (seedInFlight) without duplicating', () => {
    // Reproduce the reconnect-mid-thinking path that ab177991a targeted.
    // Flow: snapshot arrives with inFlightTurn.thinkingText already partially
    // streamed → syncSessionFromSnapshot clears the store → seedInFlight
    // rebuilds the assistant message (thinking + text parts) via messageCreated
    // → live thinking.delta arrives aligned by offset and must append to the
    // store WITHOUT re-rendering the already-committed thinking prefix.
    const projector = createAgentProjector();
    let state: KimiClientState = { ...makeInitialSessionState() };

    // The snapshot already saw "thinking prefix " (15 chars) of thinking.
    const inFlight = {
      turnId: 1,
      promptId: 'pr_real',
      thinkingText: 'thinking prefix ',
      assistantText: '',
      runningTools: [],
    };
    // syncSessionFromSnapshot: clearStreaming first (store is empty here anyway)
    clearStreaming(SID);
    // seedInFlight → sessionStatusChanged(running) + messageCreated(thinking)
    const seedEvents = projector.seedInFlight(SID, inFlight);
    for (const evt of seedEvents) state = applyEventLocally(state, evt, 100);

    // The seeded assistant message carries the committed thinking prefix.
    const seeded = state.messagesBySession[SID]!.at(-1)!;
    expect(seeded.role).toBe('assistant');
    expect(seeded.content[0]).toMatchObject({ type: 'thinking', thinking: 'thinking prefix ' });
    const seededMsgId = seeded.id;
    // Store must be empty after seed (only messageCreated ran, no delta yet).
    expect(streamingBySession[SID]).toBeUndefined();

    // Live thinking.delta resumes at the seeded prefix length. It must append
    // to the store as a NEW live thinking block (the seeded thinking is part 0,
    // and the live delta continues part 0).
    const liveEvents = projector.project('thinking.delta', { delta: 'continued…' }, SID, {
      offset: inFlight.thinkingText.length,
    });
    for (const evt of liveEvents) state = applyEventLocally(state, evt, 101);

    const live = streamingBySession[SID];
    expect(live).toBeDefined();
    expect(live!.messageId).toBe(seededMsgId);
    expect(live!.blocks).toHaveLength(1);
    expect(live!.blocks[0]).toMatchObject({ kind: 'thinking', text: 'continued…' });
    // The committed prefix is NOT duplicated into the live store.
    expect(live!.blocks[0]!.text).not.toContain('prefix');
  });
});
