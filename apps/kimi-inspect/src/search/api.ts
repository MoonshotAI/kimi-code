/**
 * REST client for the global message search endpoint:
 * `POST {baseUrl}/api/v1/search`.
 *
 * The endpoint is a cross-session full-text search over user messages,
 * assistant text and session titles. The wire shape is validated locally by
 * hand (this app does not depend on zod): a malformed envelope or payload
 * throws, individual hits with an unexpected shape are dropped rather than
 * failing the whole page.
 */

export interface SearchHit {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  /** 'main' or a subagent id; '' for title hits (they belong to the session). */
  readonly agentId: string;
  readonly role: 'user' | 'assistant' | 'title';
  readonly snippet: string;
  /** Epoch ms. */
  readonly time: number;
  /** 0-based turn ordinal (`t<turn>` in the transcript); absent for title hits. */
  readonly turn?: number | undefined;
  /** Transcript step id (`t<turn>.<step>`); assistant hits on step-aware servers. */
  readonly stepId?: string | undefined;
  readonly score: number;
}

export interface SearchIndexState {
  readonly state: 'building' | 'ready' | 'readonly';
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
}

export interface SearchPage {
  readonly items: readonly SearchHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string | undefined;
  /**
   * Set when the server truncated the literal-mode candidate set before
   * confirmation — the page may be missing real hits.
   */
  readonly incomplete?: 'candidate_cap' | undefined;
  /**
   * Which backend served the search: 'live' scanned the in-memory session
   * transcript, 'index' queried the persisted search index. Absent when the
   * server omits it or reports an unknown value.
   */
  readonly source?: 'live' | 'index' | undefined;
  readonly indexState: SearchIndexState;
}

export interface FetchSearchPageOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly query: string;
  /** Restrict to one document role; omitted searches all. */
  readonly role?: 'user' | 'assistant' | 'title' | undefined;
  /** Default server-side 'score'. */
  readonly sort?: 'score' | 'time_desc' | 'time_asc' | undefined;
  /**
   * Match mode; default server-side 'terms'. 'literal' is a substring match
   * (case-insensitive, NFKC-normalized); the server ignores `sort` and orders
   * by time desc.
   */
  readonly mode?: 'terms' | 'literal' | undefined;
  /**
   * Scope the search to one session (and optionally one agent). Wire:
   * `container: { session_id, agent_id? }`.
   */
  readonly container?:
    | { readonly sessionId: string; readonly agentId?: string | undefined }
    | undefined;
  readonly pageSize?: number | undefined;
  /** Opaque cursor from the previous page; the query conditions must not change. */
  readonly pageToken?: string | undefined;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

const ROLES = new Set(['user', 'assistant', 'title']);

function parseHit(value: unknown): SearchHit | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const h = value as Record<string, unknown>;
  if (
    typeof h['session_id'] !== 'string' ||
    typeof h['workspace_id'] !== 'string' ||
    typeof h['session_title'] !== 'string' ||
    typeof h['agent_id'] !== 'string' ||
    typeof h['role'] !== 'string' ||
    !ROLES.has(h['role']) ||
    typeof h['snippet'] !== 'string' ||
    typeof h['time'] !== 'number' ||
    typeof h['score'] !== 'number'
  ) {
    return undefined;
  }
  return {
    sessionId: h['session_id'],
    workspaceId: h['workspace_id'],
    sessionTitle: h['session_title'],
    agentId: h['agent_id'],
    role: h['role'] as SearchHit['role'],
    snippet: h['snippet'],
    time: h['time'],
    turn: typeof h['turn'] === 'number' ? h['turn'] : undefined,
    stepId: typeof h['step_id'] === 'string' ? h['step_id'] : undefined,
    score: h['score'],
  };
}

export async function fetchSearchPage(opts: FetchSearchPageOptions): Promise<SearchPage> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl}/api/v1/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: opts.query,
      role: opts.role,
      sort: opts.sort,
      mode: opts.mode,
      container:
        opts.container === undefined
          ? undefined
          : { session_id: opts.container.sessionId, agent_id: opts.container.agentId },
      page_size: opts.pageSize,
      page_token: opts.pageToken,
    }),
  });
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`search failed (${envelope.code}): ${envelope.msg}`);
  }
  const data = envelope.data as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object' || !Array.isArray(data['items'])) {
    throw new Error('search: unexpected response shape');
  }
  const rawState = (data['index_state'] ?? {}) as Record<string, unknown>;
  const items = (data['items'] as unknown[])
    .map(parseHit)
    .filter((hit): hit is SearchHit => hit !== undefined);
  return {
    items,
    hasMore: data['has_more'] === true,
    pageToken: typeof data['page_token'] === 'string' ? data['page_token'] : undefined,
    incomplete: data['incomplete'] === 'candidate_cap' ? 'candidate_cap' : undefined,
    source: data['source'] === 'live' || data['source'] === 'index' ? data['source'] : undefined,
    indexState: {
      state:
        rawState['state'] === 'building' || rawState['state'] === 'readonly'
          ? rawState['state']
          : 'ready',
      indexedSessions: Number(rawState['indexed_sessions'] ?? 0),
      totalSessions: Number(rawState['total_sessions'] ?? 0),
      documents: Number(rawState['documents'] ?? 0),
    },
  };
}
