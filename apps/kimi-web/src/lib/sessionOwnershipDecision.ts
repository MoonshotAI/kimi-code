// apps/kimi-web/src/lib/sessionOwnershipDecision.ts
// Pure decision logic for session-ownership (40921) outcomes: given the
// ownership details and the page context, decide whether to redirect to the
// owning instance, retry shortly, or just notify. No window / Vue / i18n
// dependencies — every branch is unit-testable. The composable layer owns the
// side effects (window.location.assign, sessionStorage, toasts).

import type { SessionOwnershipDetails } from '../api/daemon/sessionOwnership';

/** Notice keys under `warnings.ownership.*` for terminal (non-action) outcomes. */
export type OwnershipNotifyKey =
  | 'creatingTimeout'
  | 'holderUnresponsive'
  | 'heldByLocalInstance'
  | 'unregisteredWriter'
  | 'redirectSameHost'
  | 'redirectLoopGuard'
  | 'redirectUnavailable';

export type SessionOwnershipAction =
  /** Full-page redirect to the owning instance, carrying the current path. The
   *  caller shows the 'redirecting' notice with { origin } before navigating. */
  | { type: 'redirect'; url: string; origin: string }
  /** The session is mid-creation on the holder; retry the operation after
   *  delayMs. The caller shows the 'creating' notice. */
  | { type: 'retry'; delayMs: number }
  /** Terminal outcome — just surface the notice. */
  | { type: 'notify'; key: OwnershipNotifyKey };

export interface OwnershipDecisionContext {
  /** `location.host` of the page that hit the error ('' outside a browser). */
  currentHost: string;
  /** pathname + search + hash carried over to the owning instance on redirect. */
  currentPath: string;
  /** Redirects already started within the active budget window (loop guard). */
  redirectAttempts: number;
  maxRedirectAttempts: number;
  /** 'creating' retries already fired for this operation (retry cap). */
  creatingAttempts: number;
  maxCreatingAttempts: number;
  /** Fallback retry delay when the server omits retry_after_ms. */
  defaultRetryDelayMs: number;
}

/**
 * Normalize a holder-published `address` to an origin. The server already maps
 * wildcard hosts to 127.0.0.1; here we only add a default scheme and strip any
 * path/query/hash. Returns undefined for empty / unparseable / non-HTTP input.
 */
export function normalizePeerOrigin(address: string): string | undefined {
  const trimmed = address.trim();
  if (trimmed === '') return undefined;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Join the peer origin with the current path (guaranteed single '/'). */
export function buildPeerTargetUrl(origin: string, currentPath: string): string {
  const path = currentPath.startsWith('/') ? currentPath : `/${currentPath}`;
  return `${origin}${path}`;
}

export function decideSessionOwnershipAction(
  details: SessionOwnershipDetails,
  ctx: OwnershipDecisionContext,
): SessionOwnershipAction {
  if (details.kind === 'unregistered-writer') {
    return { type: 'notify', key: 'unregisteredWriter' };
  }

  switch (details.phase) {
    case 'creating': {
      if (ctx.creatingAttempts >= ctx.maxCreatingAttempts) {
        return { type: 'notify', key: 'creatingTimeout' };
      }
      return {
        type: 'retry',
        delayMs: details.retry_after_ms ?? ctx.defaultRetryDelayMs,
      };
    }

    case 'routable': {
      const origin = details.address !== undefined ? normalizePeerOrigin(details.address) : undefined;
      if (origin === undefined) return { type: 'notify', key: 'redirectUnavailable' };
      // Loop guard A: the "holder" resolves to ourselves — redirecting would
      // reload the same page and fail the same way forever.
      try {
        if (new URL(origin).host === ctx.currentHost) {
          return { type: 'notify', key: 'redirectSameHost' };
        }
      } catch {
        return { type: 'notify', key: 'redirectUnavailable' };
      }
      // Loop guard B: A → B → A → … chains (stale registry, clock skew, two
      // tabs fighting) must converge to a message instead of a reload storm.
      if (ctx.redirectAttempts >= ctx.maxRedirectAttempts) {
        return { type: 'notify', key: 'redirectLoopGuard' };
      }
      return { type: 'redirect', url: buildPeerTargetUrl(origin, ctx.currentPath), origin };
    }

    case 'holder-unresponsive':
      return { type: 'notify', key: 'holderUnresponsive' };

    case 'held-by-local-instance':
      return { type: 'notify', key: 'heldByLocalInstance' };
  }
}

// ---------------------------------------------------------------------------
// Redirect-attempt budget (loop guard persistence)
// ---------------------------------------------------------------------------

/** Redirects started within this window count towards the loop guard. */
export interface RedirectBudget {
  count: number;
  windowStart: number;
}

/** Parse the persisted budget. An expired or malformed record starts fresh
 *  (stale attempts must not block a legitimate future redirect forever). */
export function readRedirectBudget(
  raw: string | null,
  now: number,
  windowMs: number,
): RedirectBudget {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { count?: unknown; windowStart?: unknown };
      if (
        typeof parsed.count === 'number' &&
        Number.isFinite(parsed.count) &&
        parsed.count >= 0 &&
        typeof parsed.windowStart === 'number' &&
        Number.isFinite(parsed.windowStart) &&
        now - parsed.windowStart < windowMs
      ) {
        return { count: parsed.count, windowStart: parsed.windowStart };
      }
    } catch {
      // malformed — fall through to a fresh budget
    }
  }
  return { count: 0, windowStart: now };
}

/** Record one more redirect start within the budget's window. */
export function bumpRedirectBudget(budget: RedirectBudget): RedirectBudget {
  return { count: budget.count + 1, windowStart: budget.windowStart };
}

export function serializeRedirectBudget(budget: RedirectBudget): string {
  return JSON.stringify({ count: budget.count, windowStart: budget.windowStart });
}
