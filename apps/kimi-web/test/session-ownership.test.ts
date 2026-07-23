// apps/kimi-web/test/session-ownership.test.ts
// Session-ownership (40921) client handling: wire-details narrowing and the
// pure redirect / retry / notify decision. See
// src/api/daemon/sessionOwnership.ts and src/lib/sessionOwnershipDecision.ts.

import { describe, expect, it } from 'vitest';

import { DaemonApiError } from '../src/api/errors';
import {
  SESSION_HELD_BY_PEER_CODE,
  getSessionOwnershipDetails,
  narrowSessionOwnershipDetails,
  type SessionOwnershipDetails,
} from '../src/api/daemon/sessionOwnership';
import {
  bumpRedirectBudget,
  decideSessionOwnershipAction,
  normalizePeerOrigin,
  readRedirectBudget,
  serializeRedirectBudget,
  type OwnershipDecisionContext,
} from '../src/lib/sessionOwnershipDecision';

const ROUTABLE: SessionOwnershipDetails = {
  kind: 'held-by-peer',
  phase: 'routable',
  address: 'http://127.0.0.1:58628',
};

function makeCtx(overrides?: Partial<OwnershipDecisionContext>): OwnershipDecisionContext {
  return {
    currentHost: '127.0.0.1:58627',
    currentPath: '/sessions/sess_1?debug=1#top',
    redirectAttempts: 0,
    maxRedirectAttempts: 3,
    creatingAttempts: 0,
    maxCreatingAttempts: 3,
    defaultRetryDelayMs: 1_000,
    ...overrides,
  };
}

describe('narrowSessionOwnershipDetails', () => {
  it.each([
    ['null', null],
    ['a string', 'held-by-peer'],
    ['an empty object', {}],
    ['an unknown kind', { kind: 'held-by-something-else' }],
    ['an unknown phase', { kind: 'held-by-peer', phase: 'mystery' }],
    ['a non-string phase', { kind: 'held-by-peer', phase: 1 }],
  ])('rejects %s', (_label, input) => {
    expect(narrowSessionOwnershipDetails(input)).toBeUndefined();
  });
});

describe('getSessionOwnershipDetails', () => {
  function apiError(code: number, details: unknown): DaemonApiError {
    return new DaemonApiError({ code, msg: 'held', requestId: 'req_1', details });
  }

  it('extracts details from a 40921 DaemonApiError', () => {
    expect(
      getSessionOwnershipDetails(
        apiError(SESSION_HELD_BY_PEER_CODE, {
          kind: 'held-by-peer',
          phase: 'creating',
          retry_after_ms: 500,
        }),
      ),
    ).toEqual({ kind: 'held-by-peer', phase: 'creating', address: undefined, retry_after_ms: 500 });
  });

  it('returns undefined for other codes, malformed details, and non-API errors', () => {
    expect(
      getSessionOwnershipDetails(apiError(40401, { kind: 'held-by-peer', phase: 'routable' })),
    ).toBeUndefined();
    expect(getSessionOwnershipDetails(apiError(SESSION_HELD_BY_PEER_CODE, { nope: 1 }))).toBeUndefined();
    expect(getSessionOwnershipDetails(new Error('boom'))).toBeUndefined();
    expect(getSessionOwnershipDetails(undefined)).toBeUndefined();
  });

  it('matches the structural DaemonApiError guard (cross-realm error)', () => {
    const crossRealm = {
      name: 'DaemonApiError',
      code: SESSION_HELD_BY_PEER_CODE,
      details: { kind: 'held-by-peer', phase: 'held-by-local-instance' },
    };
    expect(getSessionOwnershipDetails(crossRealm)).toEqual({
      kind: 'held-by-peer',
      phase: 'held-by-local-instance',
      address: undefined,
      retry_after_ms: undefined,
    });
  });
});

describe('normalizePeerOrigin', () => {
  it.each([
    ['http://127.0.0.1:58628', 'http://127.0.0.1:58628'],
    ['127.0.0.1:58628', 'http://127.0.0.1:58628'],
    ['http://127.0.0.1:58628/api/v1/sessions?x=1#y', 'http://127.0.0.1:58628'],
    ['https://kimi.example.com/', 'https://kimi.example.com'],
    ['  localhost:58628  ', 'http://localhost:58628'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizePeerOrigin(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['non-http scheme', 'ftp://127.0.0.1:58628'],
  ])('rejects %s', (_label, input) => {
    expect(normalizePeerOrigin(input)).toBeUndefined();
  });
});

describe('decideSessionOwnershipAction', () => {
  it('routable with address → redirect carrying origin + current path', () => {
    expect(decideSessionOwnershipAction(ROUTABLE, makeCtx())).toEqual({
      type: 'redirect',
      origin: 'http://127.0.0.1:58628',
      url: 'http://127.0.0.1:58628/sessions/sess_1?debug=1#top',
    });
  });

  it('routable with a bare host:port address → scheme defaults to http', () => {
    const action = decideSessionOwnershipAction(
      { kind: 'held-by-peer', phase: 'routable', address: '127.0.0.1:58628' },
      makeCtx(),
    );
    expect(action).toMatchObject({ type: 'redirect', origin: 'http://127.0.0.1:58628' });
  });

  it('routable resolving to the current host → same-host notice, no redirect loop', () => {
    expect(
      decideSessionOwnershipAction(ROUTABLE, makeCtx({ currentHost: '127.0.0.1:58628' })),
    ).toEqual({ type: 'notify', key: 'redirectSameHost' });
  });

  it('routable after too many redirects → loop-guard notice', () => {
    expect(decideSessionOwnershipAction(ROUTABLE, makeCtx({ redirectAttempts: 3 }))).toEqual({
      type: 'notify',
      key: 'redirectLoopGuard',
    });
  });

  it('routable without a usable address → unavailable notice', () => {
    expect(
      decideSessionOwnershipAction({ kind: 'held-by-peer', phase: 'routable' }, makeCtx()),
    ).toEqual({ type: 'notify', key: 'redirectUnavailable' });
    expect(
      decideSessionOwnershipAction(
        { kind: 'held-by-peer', phase: 'routable', address: 'ftp://x' },
        makeCtx(),
      ),
    ).toEqual({ type: 'notify', key: 'redirectUnavailable' });
  });

  it('creating → retry with the server hint, capped by attempts', () => {
    expect(
      decideSessionOwnershipAction(
        { kind: 'held-by-peer', phase: 'creating', retry_after_ms: 250 },
        makeCtx(),
      ),
    ).toEqual({ type: 'retry', delayMs: 250 });
    // No hint → default delay.
    expect(decideSessionOwnershipAction({ kind: 'held-by-peer', phase: 'creating' }, makeCtx())).toEqual({
      type: 'retry',
      delayMs: 1_000,
    });
    // Cap exhausted → timeout notice.
    expect(
      decideSessionOwnershipAction(
        { kind: 'held-by-peer', phase: 'creating' },
        makeCtx({ creatingAttempts: 3 }),
      ),
    ).toEqual({ type: 'notify', key: 'creatingTimeout' });
  });

  it('held-by-local-instance → terminal notice', () => {
    expect(
      decideSessionOwnershipAction({ kind: 'held-by-peer', phase: 'held-by-local-instance' }, makeCtx()),
    ).toEqual({ type: 'notify', key: 'heldByLocalInstance' });
  });
});

describe('redirect budget (loop guard persistence)', () => {
  const WINDOW_MS = 5 * 60_000;

  it('starts fresh on null / malformed / expired records', () => {
    expect(readRedirectBudget(null, 1_000, WINDOW_MS)).toEqual({ count: 0, windowStart: 1_000 });
    expect(readRedirectBudget('not-json', 1_000, WINDOW_MS)).toEqual({ count: 0, windowStart: 1_000 });
    expect(readRedirectBudget('{"count":5}', 1_000, WINDOW_MS)).toEqual({ count: 0, windowStart: 1_000 });
    const stale = serializeRedirectBudget({ count: 2, windowStart: 1_000 });
    expect(readRedirectBudget(stale, 1_000 + WINDOW_MS + 1, WINDOW_MS)).toEqual({
      count: 0,
      windowStart: 1_000 + WINDOW_MS + 1,
    });
  });

  it('keeps counts inside the window and bumps without moving windowStart', () => {
    const raw = serializeRedirectBudget({ count: 2, windowStart: 1_000 });
    const budget = readRedirectBudget(raw, 2_000, WINDOW_MS);
    expect(budget).toEqual({ count: 2, windowStart: 1_000 });
    expect(bumpRedirectBudget(budget)).toEqual({ count: 3, windowStart: 1_000 });
  });
});
