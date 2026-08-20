// Relay session API (BFF): instead of writing the OAuth token into a cookie
// itself, the page trades it for a server-side session via the relay's
// exchange endpoint, which plants an HttpOnly session cookie. The token never
// touches document.cookie, and access-token renewal (refresh token) happens
// entirely on the relay — the page has no refresh logic of its own.
//
// Both endpoints are same-origin siblings of this page ({base}/login/ →
// {base}/auth/*), so plain relative URLs fit every mount prefix.

import type { TokenInfo } from '@moonshot-ai/kimi-code-oauth/device';

const ME_URL = '../auth/me';
const EXCHANGE_URL = '../auth/exchange';

/** Probe the current sign-in state (the session cookie is HttpOnly, so JS
    cannot detect it locally). True means a live session exists. Any non-200 —
    401 signed-out, 5xx relay trouble — or a network failure reads as "not
    signed in": the caller runs the device flow, and a real outage surfaces at
    the exchange step instead. The JSON content-type check guards against a
    dev server's SPA fallback, which answers 200 HTML for any path and would
    otherwise fake a session. */
export async function probeSession(): Promise<boolean> {
  try {
    const res = await fetch(ME_URL, { credentials: 'same-origin' });
    return res.ok && (res.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  }
}

/** Thrown by exchangeSession on any non-204 response. Carries the HTTP status
    so the caller can tell permanent 4xx rejections (restart the OAuth flow
    for a fresh token) from transient 5xx / network failures (safe to retry
    with the same token). */
export class ExchangeError extends Error {
  constructor(readonly status: number) {
    super(`auth exchange failed: HTTP ${status}`);
    this.name = 'ExchangeError';
  }
}

/** Trade the device-flow token for a server-side session. Resolves on 204
    (the relay has planted the cookie); rejects with an ExchangeError on any
    other status so the caller can surface the right recovery. `keepalive`
    lets the POST outlive the tab: the page may be closed (or navigated away)
    the moment sign-in looks done, and an aborted exchange would leave the UI
    claiming success with no session created. */
export async function exchangeSession(token: TokenInfo): Promise<void> {
  const res = await fetch(EXCHANGE_URL, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_in: token.expiresIn,
    }),
  });
  if (res.status !== 204) {
    throw new ExchangeError(res.status);
  }
}
