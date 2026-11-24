import { app } from 'electron';

import { log } from '../diagnostics/log';
import { trySendDesktopEvent } from '../diagnostics/track';
import { savePendingSessionContinue, takePendingSessionContinue } from '../app/ui-state';

const SESSION_CONTINUE_TTL_MS = 10 * 60 * 1_000;
const BUSY_SESSIONS_PAGE_SIZE = 100;
const BUSY_SESSIONS_PAGE_LIMIT = 10;
const CONTINUE_TIMEOUT_MS = 15_000;
const SESSION_TITLE_MAX_LENGTH = 60;

export interface BusySession {
  readonly id: string;
  readonly title: string;
  readonly turnRunning: boolean;
}

export async function listBusySessions(
  origin: string,
  token: string | undefined,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<BusySession[]> {
  const sessions: BusySession[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < BUSY_SESSIONS_PAGE_LIMIT; page += 1) {
    const response = await fetcher(busySessionsPageUrl(origin, pageToken), { headers: authHeaders(token), signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = pageData(await response.json());
    if (Array.isArray(data.items)) sessions.push(...data.items.flatMap(busySessionFrom));
    if (data.has_more !== true || typeof data.next_page_token !== 'string') break;
    pageToken = data.next_page_token;
  }
  return sessions;
}

export function prepareSessionContinue(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) {
    savePendingSessionContinue(undefined);
    return;
  }
  savePendingSessionContinue({ sessionIds: [...sessionIds], armedAt: Date.now(), fromVersion: app.getVersion() });
  log.info(`[kimi-desktop] ${sessionIds.length} running sessions will continue after the update restart`);
  trySendDesktopEvent('update_session_continue', { outcome: 'armed', session_count: sessionIds.length });
}

export async function continueSessionsAfterRestart(
  origin: string,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const pending = takePendingSessionContinue();
  if (pending === undefined || pending.sessionIds.length === 0) return;
  const sessionCount = pending.sessionIds.length;
  if (pending.fromVersion === app.getVersion()) {
    log.info(`[kimi-desktop] skipped continuing ${sessionCount} sessions: the update was not applied`);
    trySendDesktopEvent('update_session_continue', { outcome: 'not_updated', session_count: sessionCount });
    return;
  }
  const age = Date.now() - pending.armedAt;
  if (age < 0 || age > SESSION_CONTINUE_TTL_MS) {
    log.info(`[kimi-desktop] skipped continuing ${sessionCount} sessions: the update restart was too long ago`);
    trySendDesktopEvent('update_session_continue', { outcome: 'expired', session_count: sessionCount });
    return;
  }
  let continued = 0;
  for (const sessionId of pending.sessionIds) {
    if (await continueSession(origin, token, sessionId, fetcher)) continued += 1;
  }
  log.info(`[kimi-desktop] continued ${continued} of ${sessionCount} sessions after the update restart`);
  trySendDesktopEvent('update_session_continue', {
    outcome: 'attempted',
    session_count: sessionCount,
    continued_count: continued,
  });
}

async function continueSession(
  origin: string,
  token: string | undefined,
  sessionId: string,
  fetcher: typeof fetch,
): Promise<boolean> {
  let failure: string;
  try {
    const response = await fetcher(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}:continue`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(CONTINUE_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as { code?: unknown; msg?: unknown } | null;
    if (response.ok && payload?.code === 0) return true;
    failure = typeof payload?.msg === 'string' ? payload.msg : `HTTP ${response.status}`;
  } catch (error) {
    failure = errorMessage(error);
  }
  log.warn(`[kimi-desktop] session ${sessionId} was not continued after the update restart: ${failure}`);
  return false;
}

function busySessionsPageUrl(origin: string, pageToken: string | undefined): string {
  const url = `${origin}/api/v1/sessions?busy=true&archived=all&page_size=${BUSY_SESSIONS_PAGE_SIZE}`;
  return pageToken === undefined ? url : `${url}&page_token=${encodeURIComponent(pageToken)}`;
}

function pageData(payload: unknown): { items?: unknown; has_more?: unknown; next_page_token?: unknown } {
  const data = payload !== null && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined;
  return data !== null && typeof data === 'object' ? data : {};
}

function busySessionFrom(item: unknown): BusySession[] {
  if (item === null || typeof item !== 'object') return [];
  const { id, title, last_prompt: lastPrompt, activity } = item as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return [];
  return [{ id, title: sessionDisplayTitle(id, title, lastPrompt), turnRunning: activity === 'turn' }];
}

function sessionDisplayTitle(id: string, title: unknown, lastPrompt: unknown): string {
  const text = [title, lastPrompt].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const chars = Array.from((text ?? id.slice(0, 12)).replace(/\s+/g, ' ').trim());
  return chars.length > SESSION_TITLE_MAX_LENGTH
    ? `${chars.slice(0, SESSION_TITLE_MAX_LENGTH - 1).join('')}…`
    : chars.join('');
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { Authorization: `Bearer ${token}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
