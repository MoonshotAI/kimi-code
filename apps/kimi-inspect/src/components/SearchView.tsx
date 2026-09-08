/**
 * Search view — the global cross-session message search (`POST /api/v1/search`).
 * Full width like the other non-chat views. Results are pageable (Load more);
 * clicking a hit hands it to the app shell (`onOpenResult`), which switches
 * to the chat view at the hit's session / agent / turn / step.
 */

import { useState } from 'react';

import { useConnection } from '../connection';
import { fetchSearchPage, type SearchHit, type SearchIndexState } from '../search/api';
import { ActionButton, Badge, ErrorLine, relTime } from '../ui';

type RoleFilter = 'all' | 'user' | 'assistant' | 'title';
type SortOrder = 'score' | 'time_desc' | 'time_asc';
type SearchMode = 'terms' | 'literal';

const PAGE_SIZE = 20;

interface ExecutedSearch {
  readonly query: string;
  readonly role?: 'user' | 'assistant' | 'title' | undefined;
  readonly sort: SortOrder;
  readonly mode: SearchMode;
  readonly items: readonly SearchHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string | undefined;
  readonly incomplete?: 'candidate_cap' | undefined;
  readonly source?: 'live' | 'index' | undefined;
  readonly indexState: SearchIndexState;
}

export function SearchView({ onOpenResult }: { onOpenResult: (hit: SearchHit) => void }) {
  const { baseUrl, config } = useConnection();
  const [input, setInput] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [sort, setSort] = useState<SortOrder>('score');
  const [exact, setExact] = useState(false);
  const [result, setResult] = useState<ExecutedSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const runSearch = async () => {
    const query = input.trim();
    if (query === '' || searching) return;
    setSearching(true);
    setError(null);
    try {
      const token = config.token.trim();
      const mode: SearchMode = exact ? 'literal' : 'terms';
      const page = await fetchSearchPage({
        baseUrl,
        token: token === '' ? undefined : token,
        query,
        role: role === 'all' ? undefined : role,
        sort,
        mode,
        pageSize: PAGE_SIZE,
      });
      setResult({
        query,
        role: role === 'all' ? undefined : role,
        sort,
        mode,
        items: page.items,
        hasMore: page.hasMore,
        pageToken: page.pageToken,
        incomplete: page.incomplete,
        source: page.source,
        indexState: page.indexState,
      });
    } catch (error) {
      setError(error);
    } finally {
      setSearching(false);
    }
  };

  const loadMore = async () => {
    if (result === null || !result.hasMore || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const token = config.token.trim();
      const page = await fetchSearchPage({
        baseUrl,
        token: token === '' ? undefined : token,
        query: result.query,
        role: result.role,
        sort: result.sort,
        mode: result.mode,
        pageSize: PAGE_SIZE,
        pageToken: result.pageToken,
      });
      setResult({
        ...result,
        items: [...result.items, ...page.items],
        hasMore: page.hasMore,
        pageToken: page.pageToken,
        incomplete: page.incomplete,
        source: page.source,
        indexState: page.indexState,
      });
    } catch (error) {
      setError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
        <input
          className="w-96 rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-[13px] text-neutral-100 outline-none focus:border-sky-600"
          placeholder="Search messages across all sessions…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void runSearch();
            }
          }}
        />
        <select
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-[12px] text-neutral-300 outline-none"
          value={role}
          onChange={(e) => setRole(e.target.value as RoleFilter)}
          title="Document role"
        >
          <option value="all">all roles</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
          <option value="title">title</option>
        </select>
        <select
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-[12px] text-neutral-300 outline-none disabled:opacity-40"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOrder)}
          title={exact ? 'Exact match always sorts by newest first' : 'Sort order'}
          disabled={exact}
        >
          <option value="score">relevance</option>
          <option value="time_desc">newest first</option>
          <option value="time_asc">oldest first</option>
        </select>
        <label
          className="flex cursor-pointer items-center gap-1.5 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-[12px] text-neutral-300 select-none"
          title="Substring match, case-insensitive (slower, matches symbols like C++)"
        >
          <input
            type="checkbox"
            className="accent-sky-600"
            checked={exact}
            onChange={(e) => setExact(e.target.checked)}
          />
          exact match
        </label>
        <ActionButton onClick={() => void runSearch()} disabled={searching || input.trim() === ''}>
          {searching ? 'Searching…' : 'Search'}
        </ActionButton>
        {result !== null ? (
          <span className="ml-2 text-[11px] text-neutral-600">
            {result.indexState.state === 'building'
              ? `index building (${result.indexState.indexedSessions}/${result.indexState.totalSessions} sessions) — results may be incomplete`
              : `${result.indexState.documents} documents indexed (${result.indexState.state})`}
          </span>
        ) : null}
        {result?.source !== undefined ? (
          <span
            className="ml-2"
            title={
              result.source === 'live'
                ? 'searched the in-memory session transcript'
                : 'searched the persisted search index'
            }
          >
            <Badge tone={result.source === 'live' ? 'green' : 'neutral'}>
              source: {result.source}
            </Badge>
          </span>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {error !== null ? (
          <div className="mb-3">
            <ErrorLine error={error} />
          </div>
        ) : null}
        {result === null ? (
          <div className="text-[12px] text-neutral-600 italic">
            Search user prompts, assistant replies and session titles across every session.
          </div>
        ) : result.items.length === 0 && !searching ? (
          <div className="text-[12px] text-neutral-600 italic">No hits for “{result.query}”.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {result.incomplete === 'candidate_cap' ? (
              <div className="text-[11px] text-neutral-600">
                too many matches — the candidate set was truncated, results may be incomplete
              </div>
            ) : null}
            {result.items.map((hit, i) => (
              <HitCard
                key={`${hit.sessionId}/${hit.agentId}/${hit.time}/${i}`}
                hit={hit}
                onOpen={onOpenResult}
              />
            ))}
            {result.hasMore ? (
              <div className="mt-1 flex justify-center">
                <ActionButton onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </ActionButton>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function HitCard({ hit, onOpen }: { hit: SearchHit; onOpen: (hit: SearchHit) => void }) {
  return (
    <button
      type="button"
      className="w-full rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left transition-colors hover:border-sky-800 hover:bg-neutral-900"
      onClick={() => onOpen(hit)}
      title="Open in chat"
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-neutral-200">
          {hit.sessionTitle !== '' ? hit.sessionTitle : '(untitled session)'}
        </span>
        <Badge tone={hit.role === 'user' ? 'sky' : hit.role === 'assistant' ? 'green' : 'violet'}>
          {hit.role}
        </Badge>
        {hit.agentId !== '' ? <Badge tone="neutral">agent: {hit.agentId}</Badge> : null}
        <span className="ml-auto text-[10px] text-neutral-600">{relTime(hit.time)}</span>
      </div>
      <div className="mb-1 whitespace-pre-wrap text-[12px] text-neutral-300">{hit.snippet}</div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-neutral-600">
        <span>{hit.sessionId}</span>
        {hit.turn !== undefined ? <span>t{hit.turn}</span> : null}
        {hit.stepId !== undefined ? <span>{hit.stepId}</span> : null}
        <span>score {hit.score.toFixed(2)}</span>
      </div>
    </button>
  );
}
