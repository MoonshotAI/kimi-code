/**
 * WorkspaceDirBrowser — server-side filesystem browser living in the Workspace
 * Services view's left sidebar, replacing the old <select> of registered
 * workspaces. Directories are listed through the App-scope
 * `IHostFolderBrowser` (home + recent roots + one-level directory listing);
 * entries that are registered workspaces carry a `workspace` badge plus their
 * trust state (`trusted` / `untrusted`, read through the Workspace-scope
 * `IWorkspaceTrust`; servers predating that service simply show no trust
 * badge). "Select" registers the current folder on demand —
 * `IWorkspaceService.createOrTouch` is idempotent on root — before handing
 * the workspace to the parent.
 */

import {
  IHostFolderBrowser,
  type FsBrowseEntry,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import {
  IWorkspaceService,
  type Workspace,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { InspectClient } from '../channel';
import { fetchWorkspaceSnapshot } from '../snapshots/api';
import { ErrorLine } from '../ui';

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

function baseName(path: string): string {
  const normalized = normalizePath(path);
  return normalized.split('/').pop() ?? normalized;
}

export function WorkspaceDirBrowser(props: {
  klient: InspectClient;
  workspaces: readonly Workspace[] | undefined;
  onSelect: (workspace: Workspace) => void;
}) {
  const { klient, workspaces, onSelect } = props;
  const queryClient = useQueryClient();
  /** Current browsed directory; null = the server default ($HOME). */
  const [path, setPath] = useState<string | null>(null);

  const home = useQuery({
    queryKey: ['fs-home', klient.baseUrl],
    queryFn: () => klient.core(IHostFolderBrowser).home(),
  });
  const browse = useQuery({
    queryKey: ['fs-browse', klient.baseUrl, path],
    queryFn: () =>
      path === null
        ? klient.core(IHostFolderBrowser).browse()
        : klient.core(IHostFolderBrowser).browse(path),
  });

  const select = useMutation({
    mutationFn: (root: string) => klient.core(IWorkspaceService).createOrTouch(root),
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces', klient.baseUrl] });
      onSelect(workspace);
    },
  });

  const workspaceList = workspaces ?? [];
  /** normalized root → trusted; undefined when the server predates `workspaceTrust`. */
  const trustByRoot = useQuery({
    queryKey: ['workspace-trust', klient.baseUrl, workspaceList.map((ws) => ws.id).join(',')],
    enabled: workspaceList.length > 0,
    retry: false,
    queryFn: async () => {
      const entries = await Promise.all(
        workspaceList.map(async (ws) => {
          try {
            const snapshot = await fetchWorkspaceSnapshot(klient, ws.id);
            return [normalizePath(ws.root), snapshot.program.trusted] as const;
          } catch {
            return [normalizePath(ws.root), undefined] as const;
          }
        }),
      );
      return new Map(entries);
    },
  });

  const workspaceRoots = new Set(workspaceList.map((ws) => normalizePath(ws.root)));
  const current = browse.data ?? null;
  const recents = home.data?.recent_roots ?? [];
  const isCurrentWorkspace = current !== null && workspaceRoots.has(normalizePath(current.path));

  const renderEntry = (entry: FsBrowseEntry) => {
    const isWorkspace = workspaceRoots.has(normalizePath(entry.path));
    const trusted = trustByRoot.data?.get(normalizePath(entry.path));
    return (
      <button
        key={entry.path}
        type="button"
        title={entry.path}
        onClick={() => {
          setPath(entry.path);
        }}
        className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-neutral-900"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-200">
          {entry.name}/
        </span>
        {isWorkspace && trusted !== undefined ? (
          <span
            className={`shrink-0 rounded border px-1 text-[9px] font-semibold uppercase tracking-wider ${
              trusted
                ? 'border-emerald-800 text-emerald-400'
                : 'border-amber-800 text-amber-400'
            }`}
          >
            {trusted ? 'trusted' : 'untrusted'}
          </span>
        ) : null}
        {isWorkspace ? (
          <span className="shrink-0 rounded border border-sky-800 px-1 text-[9px] font-semibold uppercase tracking-wider text-sky-400">
            workspace
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1 border-b border-neutral-800 px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setPath(null);
            }}
            className="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 hover:border-sky-600"
          >
            home
          </button>
          <button
            type="button"
            disabled={!current?.parent}
            onClick={() => {
              if (current?.parent) setPath(current.parent);
            }}
            className="shrink-0 rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 hover:border-sky-600 disabled:opacity-40"
          >
            up
          </button>
          <button
            type="button"
            disabled={current === null || select.isPending}
            onClick={() => {
              if (current !== null) select.mutate(current.path);
            }}
            className="ml-auto shrink-0 rounded border border-sky-700 px-2 py-0.5 text-[10px] font-semibold text-sky-300 hover:bg-sky-950 disabled:opacity-40"
          >
            {select.isPending ? 'selecting…' : isCurrentWorkspace ? 'select' : 'register & select'}
          </button>
        </div>
        <span
          title={current?.path}
          className="truncate font-mono text-[10px] text-neutral-500"
        >
          {current?.path ?? '…'}
        </span>
      </div>
      {recents.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
            recent
          </span>
          {recents.map((root) => (
            <button
              key={root}
              type="button"
              title={root}
              onClick={() => {
                setPath(root);
              }}
              className="max-w-32 truncate rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400 hover:border-sky-600 hover:text-neutral-200"
            >
              {baseName(root)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {browse.isError ? (
          <div className="px-3 py-2">
            <ErrorLine error={browse.error} />
          </div>
        ) : current === null ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600 italic">loading…</div>
        ) : current.entries.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600 italic">no subdirectories</div>
        ) : (
          current.entries.map(renderEntry)
        )}
      </div>
      {select.isError ? (
        <div className="border-t border-neutral-800 px-3 py-1">
          <ErrorLine error={select.error} />
        </div>
      ) : null}
    </div>
  );
}
