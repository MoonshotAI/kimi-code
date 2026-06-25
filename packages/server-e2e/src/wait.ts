/**
 * Higher-level wait helpers built on top of `WsClient.waitForFrame` and
 * `HttpClient.getSession`. Kept separate from `client.ts` so scenarios can
 * import them directly without dragging the whole `DaemonClient` class.
 */
import type { Session, SessionStatus } from '@moonshot-ai/protocol';

import type { HttpClient } from './http.js';
import type { AnyFrame, WsClient } from './ws.js';

/** Default 60s wait for a single event frame — matches approval/question TTL. */
export const DEFAULT_FRAME_TIMEOUT_MS = 60_000;

/**
 * Wait for the first WS frame matching `predicate`. Thin wrapper that fills
 * the default timeout — most scenarios shouldn't have to think about it.
 */
export function waitForFrame(
  ws: WsClient,
  predicate: (frame: AnyFrame) => boolean,
  opts?: { timeoutMs?: number },
): Promise<AnyFrame> {
  return ws.waitForFrame(predicate, opts?.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS);
}

/**
 * Poll `GET /sessions/{sid}` until `status` matches. Useful as a final
 * synchronization point — the server's `turn.ended` arrives before the
 * session row flips to `idle`, so scenarios that want a quiescent session
 * must poll.
 */
export async function waitForSessionStatus(
  http: HttpClient,
  sid: string,
  status: SessionStatus,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<Session> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: Session | null = null;
  while (Date.now() < deadline) {
    const session = await http.getSession(sid);
    last = session;
    if (session.status === status) return session;
    await sleep(pollMs);
  }
  throw new Error(
    `session ${sid} did not reach status="${status}" within ${timeoutMs}ms ` +
      `(last status="${last?.status ?? 'unknown'}")`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
