/**
 * REST client for the v2 session list endpoint: `GET {baseUrl}/api/v2/sessions`.
 *
 * Unlike the v1 surface there is NO `{ code, msg, data }` envelope — a 2xx
 * body is the page payload directly, and failures carry a real HTTP status
 * plus `{ error: { code, message } }`. Pagination is an opaque cursor
 * (`page_token`) bound to the first page's query conditions; any condition
 * change mid-pagination fails server-side with 409, so callers must restart
 * from the first page instead of reusing a cursor across filters/sorts.
 *
 * The wire shape is validated locally by hand (this app does not depend on
 * zod): a malformed page throws, individual items with an unexpected shape
 * are dropped rather than failing the whole page.
 */

export type V2ActivityStatus = 'running' | 'approval' | 'question' | 'failed' | 'idle';

export type V2SessionSort =
  | 'meta.updated_at_desc'
  | 'meta.updated_at_asc'
  | 'meta.created_at_desc';

export interface V2Session {
  readonly id: string;
  readonly workspace: { readonly id: string; readonly cwd: string | null };
  readonly meta: {
    readonly title: string | null;
    readonly lastPrompt: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archived: boolean;
  };
  readonly activity: { readonly status: V2ActivityStatus };
  /** Present only when the request opted in via `include=git`. */
  readonly git?: {
    readonly branch: string | null;
    readonly pullRequest: {
      readonly number: number;
      readonly state: 'open' | 'closed' | 'merged';
      readonly url: string;
    } | null;
  };
}

export interface V2SessionsQuery {
  readonly workspaceIds?: readonly string[];
  readonly statuses?: readonly V2ActivityStatus[];
  readonly updatedAfter?: number;
  readonly archived?: 'true' | 'false' | 'all';
  readonly sort?: V2SessionSort;
  readonly includeGit?: boolean;
  readonly pageSize?: number;
  /** Opaque cursor from the previous page; the query conditions must not change. */
  readonly pageToken?: string;
}

export interface V2SessionPage {
  readonly items: readonly V2Session[];
  readonly hasMore: boolean;
  readonly nextPageToken?: string;
}

const STATUSES = new Set<V2ActivityStatus>(['running', 'approval', 'question', 'failed', 'idle']);
const PR_STATES = new Set(['open', 'closed', 'merged']);

function parsePullRequest(value: unknown): NonNullable<V2Session['git']>['pullRequest'] {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const pr = value as Record<string, unknown>;
  if (
    typeof pr['number'] !== 'number' ||
    typeof pr['state'] !== 'string' ||
    !PR_STATES.has(pr['state']) ||
    typeof pr['url'] !== 'string'
  ) {
    return null;
  }
  return { number: pr['number'], state: pr['state'] as 'open' | 'closed' | 'merged', url: pr['url'] };
}

function parseSession(value: unknown): V2Session | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const s = value as Record<string, unknown>;
  const workspace = s['workspace'] as Record<string, unknown> | null;
  const meta = s['meta'] as Record<string, unknown> | null;
  const activity = s['activity'] as Record<string, unknown> | null;
  if (
    typeof s['id'] !== 'string' ||
    workspace === null ||
    typeof workspace !== 'object' ||
    typeof workspace['id'] !== 'string' ||
    meta === null ||
    typeof meta !== 'object' ||
    typeof meta['created_at'] !== 'number' ||
    typeof meta['updated_at'] !== 'number' ||
    typeof meta['archived'] !== 'boolean' ||
    activity === null ||
    typeof activity !== 'object' ||
    typeof activity['status'] !== 'string' ||
    !STATUSES.has(activity['status'] as V2ActivityStatus)
  ) {
    return undefined;
  }
  const cwd = workspace['cwd'];
  const title = meta['title'];
  const lastPrompt = meta['last_prompt'];
  let git: V2Session['git'];
  if ('git' in s) {
    const g = s['git'] as Record<string, unknown> | null;
    if (g !== null && typeof g === 'object' && !Array.isArray(g)) {
      git = {
        branch: typeof g['branch'] === 'string' ? g['branch'] : null,
        pullRequest: parsePullRequest(g['pull_request']),
      };
    }
  }
  return {
    id: s['id'],
    workspace: { id: workspace['id'], cwd: typeof cwd === 'string' ? cwd : null },
    meta: {
      title: typeof title === 'string' ? title : null,
      lastPrompt: typeof lastPrompt === 'string' ? lastPrompt : null,
      createdAt: meta['created_at'],
      updatedAt: meta['updated_at'],
      archived: meta['archived'],
    },
    activity: { status: activity['status'] as V2ActivityStatus },
    git,
  };
}

export async function fetchV2SessionsPage(
  opts: { readonly baseUrl: string; readonly token?: string } & V2SessionsQuery & {
      readonly fetchImpl?: typeof fetch;
    },
): Promise<V2SessionPage> {
  const params = new URLSearchParams();
  for (const id of opts.workspaceIds ?? []) params.append('workspace.id', id);
  for (const status of opts.statuses ?? []) params.append('activity.status', status);
  if (opts.updatedAfter !== undefined) params.set('meta.updated_after', String(opts.updatedAfter));
  if (opts.archived !== undefined) params.set('meta.archived', opts.archived);
  if (opts.sort !== undefined) params.set('sort', opts.sort);
  if (opts.includeGit === true) params.set('include', 'git');
  if (opts.pageSize !== undefined) params.set('page_size', String(opts.pageSize));
  if (opts.pageToken !== undefined) params.set('page_token', opts.pageToken);

  const headers: Record<string, string> = {};
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const query = params.toString();
  const res = await doFetch(
    `${opts.baseUrl}/api/v2/sessions${query === '' ? '' : `?${query}`}`,
    { headers },
  );
  const body: unknown = await res.json();
  if (!res.ok) {
    const error = (body as Record<string, unknown> | null)?.['error'] as
      | Record<string, unknown>
      | undefined;
    const code = typeof error?.['code'] === 'string' ? error['code'] : `http_${res.status}`;
    const message = typeof error?.['message'] === 'string' ? error['message'] : res.statusText;
    throw new Error(`v2 sessions failed (${code}): ${message}`);
  }
  const data = body as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object' || !Array.isArray(data['items'])) {
    throw new Error('v2 sessions: unexpected response shape');
  }
  const items = (data['items'] as unknown[])
    .map(parseSession)
    .filter((s): s is V2Session => s !== undefined);
  return {
    items,
    hasMore: data['has_more'] === true,
    nextPageToken:
      typeof data['next_page_token'] === 'string' ? data['next_page_token'] : undefined,
  };
}
