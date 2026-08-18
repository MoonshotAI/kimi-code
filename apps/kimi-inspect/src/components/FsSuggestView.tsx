import { IWorkspaceService, type Workspace } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useConnection } from '../connection';
import { fetchWorkspaceFsSuggest, type FsSuggestResult } from '../fs/api';
import { Badge, ErrorLine } from '../ui';
import { WorkspaceDirBrowser } from './WorkspaceDirBrowser';

function parseGlobs(value: string): string[] | undefined {
  const globs = value
    .split(',')
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
  return globs.length === 0 ? undefined : globs;
}

export function FsSuggestView() {
  const { klient, baseUrl } = useConnection();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState('50');
  const [followGitignore, setFollowGitignore] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [includeGlobs, setIncludeGlobs] = useState('');
  const [excludeGlobs, setExcludeGlobs] = useState('');

  const workspaces = useQuery({
    queryKey: ['workspaces', klient.baseUrl],
    queryFn: () => klient.core(IWorkspaceService).list(),
  });

  const suggest = useMutation<FsSuggestResult, Error>({
    mutationFn: async () => {
      if (workspace === null) throw new Error('select a workspace first');
      const parsedLimit = Number.parseInt(limit, 10);
      return fetchWorkspaceFsSuggest({
        baseUrl: klient.baseUrl,
        token: klient.token,
        workspace: workspace.id,
        query,
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined,
        followGitignore,
        showHidden,
        includeGlobs: parseGlobs(includeGlobs),
        excludeGlobs: parseGlobs(excludeGlobs),
      });
    },
  });

  useEffect(() => {
    setWorkspace(null);
    suggest.reset();
  }, [baseUrl]);

  const selectWorkspace = (next: Workspace) => {
    setWorkspace(next);
    suggest.reset();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
        <div className="border-b border-neutral-800 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Workspace
          </div>
          <div title={workspace?.root} className="truncate font-mono text-[11px] text-neutral-300">
            {workspace === null ? <span className="text-neutral-600 italic">none selected</span> : `${workspace.name} — ${workspace.root}`}
          </div>
          {workspaces.isError ? <ErrorLine error={workspaces.error} /> : null}
        </div>
        <WorkspaceDirBrowser
          klient={klient}
          workspaces={workspaces.data}
          onSelect={selectWorkspace}
        />
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-6xl space-y-4">
          <div>
            <h1 className="text-sm font-semibold text-neutral-200">Filesystem Suggest</h1>
            <p className="mt-1 text-[11px] text-neutral-500">
              Query file and directory completion candidates from the selected workspace.
            </p>
          </div>
          <form
            className="grid gap-3 rounded border border-neutral-800 bg-neutral-900/30 p-3 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              suggest.mutate();
            }}
          >
            <label className="md:col-span-2">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Query
              </span>
              <input
                autoFocus
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-[12px] text-neutral-100 outline-none focus:border-sky-600"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="apps/de or README"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Limit
              </span>
              <input
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-[12px] text-neutral-100 outline-none focus:border-sky-600"
                inputMode="numeric"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </label>
            <div className="flex items-end gap-4 pb-1 text-[11px] text-neutral-300">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={followGitignore}
                  onChange={(event) => setFollowGitignore(event.target.checked)}
                />
                follow gitignore
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />
                show hidden
              </label>
            </div>
            <label>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Include globs
              </span>
              <input
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
                value={includeGlobs}
                onChange={(event) => setIncludeGlobs(event.target.value)}
                placeholder="**/*.ts, src/**"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Exclude globs
              </span>
              <input
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
                value={excludeGlobs}
                onChange={(event) => setExcludeGlobs(event.target.value)}
                placeholder="dist/**, node_modules/**"
              />
            </label>
            <div className="flex items-end md:col-span-2">
              <button
                type="submit"
                disabled={workspace === null || suggest.isPending}
                className="rounded bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {suggest.isPending ? 'loading…' : 'Suggest'}
              </button>
              {workspace === null ? (
                <span className="ml-3 text-[11px] text-neutral-600">select a workspace first</span>
              ) : null}
            </div>
          </form>
          {suggest.isError ? <ErrorLine error={suggest.error} /> : null}
          {suggest.data === undefined && !suggest.isError ? (
            <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-[12px] text-neutral-600">
              Submit a query to inspect the complete response.
            </div>
          ) : null}
          {suggest.data !== undefined ? <SuggestResult result={suggest.data} /> : null}
        </div>
      </main>
    </div>
  );
}

function SuggestResult({ result }: { readonly result: FsSuggestResult }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] text-neutral-400">
        <span>{result.items.length} items</span>
        <Badge tone={result.truncated ? 'amber' : 'green'}>
          {result.truncated ? 'truncated' : 'complete'}
        </Badge>
      </div>
      <section className="overflow-x-auto rounded border border-neutral-800">
        <table className="w-full min-w-[680px] text-left text-[11px]">
          <thead className="border-b border-neutral-800 bg-neutral-900/50 text-neutral-500">
            <tr>
              <th className="px-2 py-1.5">path</th>
              <th className="px-2 py-1.5">name</th>
              <th className="px-2 py-1.5">kind</th>
              <th className="px-2 py-1.5">score</th>
              <th className="px-2 py-1.5">match positions</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <tr key={item.path} className="border-b border-neutral-900 last:border-0">
                <td className="px-2 py-1.5 font-mono text-neutral-200">{item.path}</td>
                <td className="px-2 py-1.5 font-mono text-neutral-400">{item.name}</td>
                <td className="px-2 py-1.5 text-neutral-400">{item.kind}</td>
                <td className="px-2 py-1.5 font-mono text-neutral-400">{item.score}</td>
                <td className="px-2 py-1.5 font-mono text-neutral-400">
                  {item.matchPositions.join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.items.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-neutral-600">no matching items</div>
        ) : null}
      </section>
      <details className="rounded border border-neutral-800 bg-neutral-950/50">
        <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          Full JSON response
        </summary>
        <pre className="max-h-[420px] overflow-auto border-t border-neutral-800 p-3 text-[11px] leading-relaxed text-neutral-300">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </div>
  );
}
