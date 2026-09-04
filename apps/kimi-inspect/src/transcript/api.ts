/**
 * REST client for the history endpoint of the message protocol:
 * `GET {baseUrl}/api/v1/sessions/{sessionId}/history`.
 *
 * This is the ONLY source of persisted (completed) timeline state: the
 * initial load fetches the newest page, "load earlier" pages further with a
 * `before_turn` cursor, and a reconnect catch-up pages forward from an
 * `after_step` cursor. The in-flight step's entities arrive over the WS
 * recovery payload instead (idempotent replace-by-id at the seam).
 *
 * Pages are flat entity-message slices (`{ messages, in_flight? }`,
 * time-ordered, same schemas as the WS stream). There is deliberately no
 * has-more flag: a page shorter than `page_size` is the end in that
 * direction, an empty page is definitive.
 */

import { historyResponseSchema, type HistoryMessage } from '@moonshot-ai/kap-server/protocol';

export const HISTORY_PAGE_SIZE = 500;

export interface HistoryPage {
  readonly messages: readonly HistoryMessage[];
  /** Current streaming position of a live session; absent for idle/cold ones. */
  readonly inFlight?: { turn_id: string; step_id: string };
}

export interface FetchHistoryPageOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly agentId: string;
  /** Turn-id cursor; fetches up to `pageSize` messages strictly older than that turn. */
  readonly beforeTurn?: string;
  /** Step-id cursor; fetches up to `pageSize` messages strictly newer than that step. */
  readonly afterStep?: string;
  readonly pageSize?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

export async function fetchHistoryPage(opts: FetchHistoryPageOptions): Promise<HistoryPage> {
  const params = new URLSearchParams({
    agent_id: opts.agentId,
    page_size: String(opts.pageSize ?? HISTORY_PAGE_SIZE),
  });
  if (opts.beforeTurn !== undefined) params.set('before_turn', opts.beforeTurn);
  if (opts.afterStep !== undefined) params.set('after_step', opts.afterStep);
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    `${opts.baseUrl}/api/v1/sessions/${encodeURIComponent(opts.sessionId)}/history?${params.toString()}`,
    { headers },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`history page failed (${envelope.code}): ${envelope.msg}`);
  }
  const parsed = historyResponseSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new Error('history page: unexpected response shape');
  }
  return { messages: parsed.data.messages, inFlight: parsed.data.in_flight };
}

/**
 * Read the agent's WHOLE history (newest page + `before_turn` paging to the
 * beginning) in timeline order. On-demand debug reads only (plan lookup) —
 * the chat channel pages lazily instead.
 */
export async function fetchFullHistory(opts: {
  readonly baseUrl: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly pageSize?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<readonly HistoryMessage[]> {
  const pageSize = opts.pageSize ?? HISTORY_PAGE_SIZE;
  const messages: HistoryMessage[] = [];
  const seen = new Set<string>();
  let beforeTurn: string | undefined;
  for (;;) {
    const page = await fetchHistoryPage({ ...opts, beforeTurn, pageSize });
    if (page.messages.length === 0) break;
    const fresh: HistoryMessage[] = [];
    for (const message of page.messages) {
      const key = historyEntityKey(message);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(message);
    }
    messages.unshift(...fresh);
    if (page.messages.length < pageSize) break;
    const oldest = page.messages.find((message) => 'turn_id' in message)?.turn_id;
    if (oldest === undefined || oldest === beforeTurn) break;
    beforeTurn = oldest;
  }
  return messages;
}

function historyEntityKey(message: HistoryMessage): string {
  switch (message.type) {
    case 'turn':
      return `turn:${message.turn_id}`;
    case 'step':
      return `step:${message.step_id}`;
    case 'user':
    case 'assistant':
    case 'thinking':
      return `${message.type}:${message.message_id}`;
    case 'tool_call':
      return `tool_call:${message.tool_call_id}`;
    case 'system':
      return `system:${message.system_id}`;
    case 'interaction':
      return `interaction:${message.interaction_id}`;
    case 'task':
      return `task:${message.task_id}`;
    case 'todo':
      return `todo:${message.todo_id}`;
  }
}
