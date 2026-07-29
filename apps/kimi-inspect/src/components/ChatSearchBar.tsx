/**
 * In-chat search bar — searches the messages of the CURRENT session only
 * (`container: { session_id }` on `POST /api/v1/search`; the whole session,
 * not just the active agent) and renders the first page as a dropdown under
 * the input. Clicking a hit hands it to the app shell (`onOpenHit`), which
 * switches the agent when the hit belongs to another one and jumps the
 * transcript to the hit's turn / step. Esc or an outside click closes the
 * panel.
 */

import { useEffect, useRef, useState } from 'react';

import { useConnection } from '../connection';
import { fetchSearchPage, type SearchHit } from '../search/api';
import { Badge, ErrorLine, relTime } from '../ui';

const PAGE_SIZE = 20;

export function ChatSearchBar({
  sessionId,
  onOpenHit,
}: {
  sessionId: string;
  onOpenHit?: ((hit: SearchHit) => void) | undefined;
}) {
  const { baseUrl, config } = useConnection();
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // A session switch drops the previous session's query and results.
  useEffect(() => {
    setInput('');
    setHits(null);
    setError(null);
    setOpen(false);
  }, [sessionId]);

  // Clicking outside the bar closes the result panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const search = async () => {
    const query = input.trim();
    if (query === '' || searching) return;
    setSearching(true);
    setError(null);
    setOpen(true);
    try {
      const token = config.token.trim();
      const page = await fetchSearchPage({
        baseUrl,
        token: token === '' ? undefined : token,
        query,
        // Substring semantics (Ctrl+F-like): terms mode is whole-token matching,
        // which surprises in an in-session search box.
        mode: 'literal',
        container: { sessionId },
        pageSize: PAGE_SIZE,
      });
      setHits(page.items);
    } catch (error) {
      setHits(null);
      setError(error);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div ref={rootRef} className="relative border-b border-neutral-800 px-4 py-2">
      <input
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-[13px] text-neutral-100 outline-none focus:border-sky-600"
        placeholder="Search this session… (Enter to search, Esc to close)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void search();
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        onFocus={() => {
          if (hits !== null) setOpen(true);
        }}
      />
      {open ? (
        <div className="absolute inset-x-4 top-full z-10 mt-1 max-h-80 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 p-2 shadow-lg shadow-black/40">
          {searching ? (
            <div className="px-1 py-1 text-[12px] text-neutral-600 italic">Searching…</div>
          ) : error !== null ? (
            <ErrorLine error={error} />
          ) : hits === null ? null : hits.length === 0 ? (
            <div className="px-1 py-1 text-[12px] text-neutral-600 italic">
              No hits in this session.
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {hits.map((hit, i) => (
                <button
                  key={`${hit.agentId}/${hit.time}/${i}`}
                  type="button"
                  className="w-full rounded border border-transparent px-2 py-1.5 text-left transition-colors hover:border-sky-800 hover:bg-neutral-800/60"
                  onClick={() => {
                    setOpen(false);
                    onOpenHit?.(hit);
                  }}
                  title="Open in chat"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        hit.role === 'user' ? 'sky' : hit.role === 'assistant' ? 'green' : 'violet'
                      }
                    >
                      {hit.role}
                    </Badge>
                    {hit.agentId !== '' ? <Badge tone="neutral">agent: {hit.agentId}</Badge> : null}
                    <span className="ml-auto text-[10px] text-neutral-600">{relTime(hit.time)}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-[12px] text-neutral-300">
                    {hit.snippet}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
