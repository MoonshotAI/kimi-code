import { describe, expect, it } from 'vitest';
import { buildAgentErrorNotice, createInitialState, reduceAppEvent } from '@moonshot-ai/app-core/api';
import type { AppNotice, AppSession } from '../../src/renderer/api/types';
import { i18n } from '../../src/renderer/i18n';

function makeSession(id: string, updatedAt: string): AppSession {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    busy: false,
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
  };
}

describe('reduceAppEvent sessionWorkChanged', () => {
  it('updates list-level main-turn liveness for an unopened session', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: true,
        mainTurnActive: true,
      },
      { sessionId: 's1' },
    );

    expect(next.sessions[0]).toMatchObject({
      busy: true,
      mainTurnActive: true,
    });
  });

  it('updates the listed action-required fallback for an unopened session', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: true,
        pendingInteraction: 'question',
      },
      { sessionId: 's1' },
    );

    expect(next.sessions[0]?.pendingInteraction).toBe('question');
  });

  it('clears streamed main-turn liveness while aggregate work remains busy', () => {
    const state = {
      ...createInitialState(),
      sessions: [
        {
          ...makeSession('s1', '2026-01-01T00:00:00.000Z'),
          busy: true,
          mainTurnActive: true,
        },
      ],
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: true,
        mainTurnActive: false,
        pendingInteraction: 'none',
      },
      { sessionId: 's1' },
    );

    expect(next.sessions[0]).toMatchObject({ busy: true, mainTurnActive: false });
  });

  it('clears stale main-turn liveness when an idle update omits the optional field', () => {
    const state = {
      ...createInitialState(),
      sessions: [
        {
          ...makeSession('s1', '2026-01-01T00:00:00.000Z'),
          busy: true,
          mainTurnActive: true,
        },
      ],
    };

    const next = reduceAppEvent(
      state,
      {
        type: 'sessionWorkChanged',
        sessionId: 's1',
        busy: false,
      },
      { sessionId: 's1' },
    );

    expect(next.sessions[0]).toMatchObject({ busy: false, mainTurnActive: false });
  });

  it('clears a stale turn outcome when the update omits lastTurnReason', () => {
    const state = {
      ...createInitialState(),
      sessions: [
        {
          ...makeSession('s1', '2026-01-01T00:00:00.000Z'),
          busy: false,
          lastTurnReason: 'cancelled' as const,
        },
      ],
    };

    const cleared = reduceAppEvent(
      state,
      { type: 'sessionWorkChanged', sessionId: 's1', busy: true },
      { sessionId: 's1' },
    );
    expect(cleared.sessions[0]?.lastTurnReason).toBeUndefined();

    const set = reduceAppEvent(
      state,
      { type: 'sessionWorkChanged', sessionId: 's1', busy: false, lastTurnReason: 'failed' },
      { sessionId: 's1' },
    );
    expect(set.sessions[0]?.lastTurnReason).toBe('failed');
  });
});

describe('reduceAppEvent sessions reference stability', () => {
  it('reuses the sessions reference for an event that does not touch sessions', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'unknown', raw: { _noop: true, _wireType: 'event.capability.changed' } },
      { sessionId: 's1' },
    );
    expect(next.sessions).toBe(state.sessions);
  });

  it('produces a new sessions array for an event that changes sessions', () => {
    const state = {
      ...createInitialState(),
      sessions: [makeSession('s1', '2026-01-01T00:00:00.000Z')],
    };
    const next = reduceAppEvent(
      state,
      { type: 'sessionCreated', session: makeSession('s2', '2026-02-01T00:00:00.000Z') },
      { sessionId: 's2' },
    );
    expect(next.sessions).not.toBe(state.sessions);
    expect(next.sessions.map((s) => s.id)).toEqual(['s2', 's1']);
  });
});

describe('buildAgentErrorNotice', () => {
  function build(raw: Parameters<typeof buildAgentErrorNotice>[0]): AppNotice {
    return buildAgentErrorNotice(raw, (k, p) => (p === undefined ? i18n.global.t(k) : i18n.global.t(k, p)));
  }

  it('surfaces a rate-limit failure as a structured notice with its code and server details', () => {
    const detail = JSON.stringify({ name: 'RateLimitError', statusCode: 429, requestId: 'req_1' }, null, 2);
    const notice = build({
      level: 'error',
      title: 'Rate limit reached for requests. Please try again later.',
      code: 'provider.rate_limit',
      detail,
    });
    expect(notice.severity).toBe('error');
    expect(notice.title).toBe(i18n.global.t('warnings.agentError.rateLimit'));
    expect(notice.message).toBe('Rate limit reached for requests. Please try again later.');
    expect(notice.details).toEqual([
      { label: i18n.global.t('warnings.details.code'), value: 'provider.rate_limit' },
      { label: i18n.global.t('warnings.details.details'), value: detail },
    ]);
  });

  it('shows a connection failure with only its code row', () => {
    const notice = build({ level: 'error', title: 'Connection error.', code: 'provider.connection_error' });
    expect(notice.title).toBe(i18n.global.t('warnings.agentError.connection'));
    expect(notice.message).toBe('Connection error.');
    expect(notice.details?.map((d) => d.value)).toEqual(['provider.connection_error']);
  });

  it('falls back to the generic title for unmapped or missing codes', () => {
    for (const code of ['internal', undefined]) {
      const notice = build({ level: 'error', title: 'boom', code });
      expect(notice.title).toBe(i18n.global.t('warnings.agentError.title'));
      expect(notice.message).toBe('boom');
    }
    expect(build({ level: 'error', title: 'boom' }).details).toBeUndefined();
  });
});
