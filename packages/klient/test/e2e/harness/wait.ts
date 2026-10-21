import type { Session } from '@moonshot-ai/kap-server/protocol/session';

import type { HttpClient } from './http.js';
import type { AnyFrame, WsClient } from './ws.js';

export const DEFAULT_FRAME_TIMEOUT_MS = 60_000;

export function waitForFrame(
  ws: WsClient,
  predicate: (frame: AnyFrame) => boolean,
  opts?: { timeoutMs?: number },
): Promise<AnyFrame> {
  return ws.waitForFrame(predicate, opts?.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS);
}

export async function waitForSessionBusy(
  http: HttpClient,
  sid: string,
  busy: boolean,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<Session> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: Session | null = null;
  while (Date.now() < deadline) {
    const session = await http.getSession(sid);
    last = session;
    if (session.busy === busy) return session;
    await sleep(pollMs);
  }
  throw new Error(
    `session ${sid} did not reach busy=${busy} within ${timeoutMs}ms ` +
      `(last busy=${last?.busy ?? 'unknown'})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
