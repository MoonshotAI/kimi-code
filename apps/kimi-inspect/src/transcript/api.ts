/**
 * REST client for the transcript page endpoint:
 * `GET {baseUrl}/api/v1/sessions/{sessionId}/transcript`.
 *
 * This is the ONLY source of full transcript state: the initial load fetches
 * the newest page, a full refresh re-reads page by page from the tail
 * backwards, and "load earlier" pages further with a `before_turn` cursor.
 * (The WS channel, by contrast, carries incremental `transcript.ops` only.)
 *
 * Pages are turn-segment slices keyed by a turn-id cursor (`before_turn`
 * pages towards older turns). The response is validated with the
 * package-owned `transcriptResponseSchema` — the schema is the single source
 * of truth for the wire shape, local code consumes the domain model types.
 */

import {
  transcriptResponseSchema,
  type TranscriptAttachment,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptMeta,
  type TranscriptTask,
  type TranscriptTodo,
} from '@moonshot-ai/transcript';

/** One transcript page as merged by the chat store. */
export interface TranscriptPage {
  readonly items: readonly TranscriptItem[];
  /** `has_more` in the query direction — more older turns exist. */
  readonly hasMoreOlder: boolean;
  /** Global, unpaginated state (every response carries the current whole). */
  readonly tasks: readonly TranscriptTask[];
  readonly interactions: readonly TranscriptInteraction[];
  readonly attachments: readonly TranscriptAttachment[];
  readonly todos: readonly TranscriptTodo[];
  readonly meta: TranscriptMeta;
  readonly pendingInteractions: readonly string[];
}

export const TRANSCRIPT_PAGE_SIZE = 30;

export interface FetchTranscriptPageOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  /** Turn-id cursor; when set, fetches up to `pageSize` segments strictly older. */
  readonly beforeTurn?: string | undefined;
  readonly pageSize?: number | undefined;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

export async function fetchTranscriptPage(
  opts: FetchTranscriptPageOptions,
): Promise<TranscriptPage> {
  const params = new URLSearchParams({
    agent_id: opts.agentId,
    page_size: String(opts.pageSize ?? TRANSCRIPT_PAGE_SIZE),
  });
  if (opts.beforeTurn !== undefined) params.set('before_turn', opts.beforeTurn);
  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    `${opts.baseUrl}/api/v1/sessions/${encodeURIComponent(opts.sessionId)}/transcript?${params.toString()}`,
    { headers },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`transcript page failed (${envelope.code}): ${envelope.msg}`);
  }
  const parsed = transcriptResponseSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new Error('transcript page: unexpected response shape');
  }
  const items: readonly TranscriptItem[] = parsed.data.items;
  const tasks: readonly TranscriptTask[] = parsed.data.tasks;
  const interactions: readonly TranscriptInteraction[] = parsed.data.interactions;
  const attachments: readonly TranscriptAttachment[] = parsed.data.attachments;
  const todos: readonly TranscriptTodo[] = parsed.data.todos;
  return {
    items,
    hasMoreOlder: parsed.data.has_more,
    tasks,
    interactions,
    attachments,
    todos,
    meta: parsed.data.meta,
    pendingInteractions: parsed.data.pending_interactions,
  };
}
