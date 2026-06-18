// apps/kimi-web/test/session-meta-updated.test.ts
//
// The daemon emits `session.meta.updated` whenever a session's title or last
// user prompt changes. The projector must forward BOTH fields so the cached
// session list stays fresh — otherwise sidebar search by the latest prompt
// text goes stale until a full reload.

import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import { createInitialState, reduceAppEvent, type KimiClientState } from '../src/api/daemon/eventReducer';
import type { AppEvent, AppSession } from '../src/api/types';

const SESSION = 'sess_1';

function seedSession(): AppSession {
  return {
    id: SESSION,
    title: 'Old title',
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    status: 'idle',
    archived: false,
    cwd: '/repo',
    model: 'kimi-test',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 128_000,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    lastPrompt: 'old prompt',
  };
}

function play(events: [string, unknown][], initial?: KimiClientState): { state: KimiClientState; appEvents: AppEvent[] } {
  const projector = createAgentProjector();
  let state = initial ?? createInitialState();
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

describe('session.meta.updated pipeline', () => {
  it('forwards lastPrompt so the cached session stays searchable', () => {
    const initial: KimiClientState = { ...createInitialState(), sessions: [seedSession()] };

    const { state, appEvents } = play(
      [['session.meta.updated', { patch: { lastPrompt: 'fix the sidebar search' } }]],
      initial,
    );

    expect(appEvents).toEqual([
      { type: 'sessionMetaUpdated', sessionId: SESSION, lastPrompt: 'fix the sidebar search' },
    ]);
    const session = state.sessions.find((s) => s.id === SESSION);
    expect(session?.lastPrompt).toBe('fix the sidebar search');
    // Title untouched when not present in the patch.
    expect(session?.title).toBe('Old title');
  });

  it('still forwards title and patches it alongside lastPrompt', () => {
    const initial: KimiClientState = { ...createInitialState(), sessions: [seedSession()] };

    const { state } = play(
      [['session.meta.updated', { patch: { title: 'New title', lastPrompt: 'latest prompt' } }]],
      initial,
    );

    const session = state.sessions.find((s) => s.id === SESSION);
    expect(session?.title).toBe('New title');
    expect(session?.lastPrompt).toBe('latest prompt');
  });

  it('emits nothing when the patch carries neither title nor lastPrompt', () => {
    const { appEvents } = play([['session.meta.updated', { patch: {} }]]);
    expect(appEvents).toEqual([]);
  });
});
