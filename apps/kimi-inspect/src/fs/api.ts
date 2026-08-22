export type FsSuggestKind = 'file' | 'directory' | 'symlink';

export interface FsSuggestItem {
  readonly path: string;
  readonly name: string;
  readonly kind: FsSuggestKind;
  readonly score: number;
  readonly matchPositions: readonly number[];
}

export interface FsSuggestResult {
  readonly items: readonly FsSuggestItem[];
  readonly truncated: boolean;
}

export interface FetchWorkspaceFsSuggestOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly workspace: string;
  readonly query: string;
  readonly limit?: number;
  readonly followGitignore?: boolean;
  readonly showHidden?: boolean;
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly runtimeId?: string;
  readonly fetchImpl?: typeof fetch;
}

const KINDS = new Set<FsSuggestKind>(['file', 'directory', 'symlink']);

function parseItem(value: unknown): FsSuggestItem | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item['path'] !== 'string' ||
    typeof item['name'] !== 'string' ||
    typeof item['kind'] !== 'string' ||
    !KINDS.has(item['kind'] as FsSuggestKind) ||
    typeof item['score'] !== 'number' ||
    !Array.isArray(item['match_positions']) ||
    !item['match_positions'].every((position) => typeof position === 'number')
  ) {
    return undefined;
  }
  return {
    path: item['path'],
    name: item['name'],
    kind: item['kind'] as FsSuggestKind,
    score: item['score'],
    matchPositions: item['match_positions'] as number[],
  };
}

export async function fetchWorkspaceFsSuggest(
  opts: FetchWorkspaceFsSuggestOptions,
): Promise<FsSuggestResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/api/v1/workspace/fs:suggest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspace: opts.workspace,
      query: opts.query,
      limit: opts.limit,
      follow_gitignore: opts.followGitignore,
      show_hidden: opts.showHidden,
      include_globs: opts.includeGlobs,
      exclude_globs: opts.excludeGlobs,
      runtime_id: opts.runtimeId,
    }),
  });
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`workspace fs:suggest failed (${envelope.code}): ${envelope.msg}`);
  }
  const data = envelope.data as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object' || !Array.isArray(data['items'])) {
    throw new Error('workspace fs:suggest: unexpected response shape');
  }
  return {
    items: (data['items'] as unknown[])
      .map(parseItem)
      .filter((item): item is FsSuggestItem => item !== undefined),
    truncated: data['truncated'] === true,
  };
}
