/**
 * Workspace Services view — the workspace-scope Service reflection as a
 * standalone rail view. Same Postman-style three-pane layout
 * (`ScopePanelsScrollspy`) as App Services, plus a workspace picker on top:
 * the proxies resolve on the `/workspace/:id` route, so a workspace must be
 * selected before any Service is callable. Picking one materializes its
 * handler on demand server-side (`IWorkspaceLifecycleService.handlerFor` is
 * create-or-get), no manual join needed.
 */

import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { serviceByName } from '../channel';
import { useConnection } from '../connection';
import type { AnyService } from '../panels';
import { ErrorLine } from '../ui';
import { ScopePanelsScrollspy } from './ServicePanels';

export function WorkspaceServicesView() {
  const { klient, baseUrl } = useConnection();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const workspaces = useQuery({
    queryKey: ['workspaces', klient.baseUrl],
    queryFn: () => klient.core(IWorkspaceService).list(),
  });

  // Switching servers invalidates the selection: workspaces belong to the
  // server they were listed from.
  useEffect(() => {
    setWorkspaceId(null);
  }, [baseUrl]);

  const sorted = (workspaces.data ?? []).toSorted((a, b) => b.lastOpenedAt - a.lastOpenedAt);

  const proxyFor = useCallback(
    (name: string): AnyService | null =>
      workspaceId === null
        ? null
        : (serviceByName<AnyService>(klient, name, { scope: 'workspace', workspaceId }) ?? null),
    [klient, workspaceId],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Workspace
        </span>
        <select
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600 sm:max-w-md"
          value={workspaceId ?? ''}
          onChange={(e) => setWorkspaceId(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Select a workspace…</option>
          {sorted.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.name} — {ws.root}
            </option>
          ))}
        </select>
        {workspaces.isError ? <ErrorLine error={workspaces.error} /> : null}
      </div>
      {workspaceId === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-[12px] text-neutral-600 italic">
          select a workspace to inspect its Services
        </div>
      ) : (
        <ScopePanelsScrollspy
          key={workspaceId}
          scope="workspace"
          title="Workspace Services"
          proxyFor={proxyFor}
        />
      )}
    </div>
  );
}
