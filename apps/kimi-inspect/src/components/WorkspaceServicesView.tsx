/**
 * Workspace Services view — the workspace-scope Service reflection as a
 * standalone rail view. Same Postman-style three-pane layout
 * (`ScopePanelsScrollspy`) as App Services, plus a left sidebar holding the
 * workspace picker: a server-side directory browser (`WorkspaceDirBrowser`,
 * over the App-scope `IHostFolderBrowser`) that marks already-registered
 * workspaces and registers a picked folder on demand. The proxies resolve on
 * the `/workspace/:id` route, so a workspace must be selected before any
 * Service is callable. Picking one materializes its handler on demand
 * server-side (`IWorkspaceLifecycleService.handlerFor` is create-or-get), no
 * manual join needed.
 */

import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { serviceByName } from '../channel';
import { useConnection } from '../connection';
import type { AnyService } from '../panels';
import { ErrorLine } from '../ui';
import { ScopePanelsScrollspy } from './ServicePanels';
import { WorkspaceDirBrowser } from './WorkspaceDirBrowser';

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

  const selected = (workspaces.data ?? []).find((ws) => ws.id === workspaceId);

  const proxyFor = useCallback(
    (name: string): AnyService | null =>
      workspaceId === null
        ? null
        : (serviceByName<AnyService>(klient, name, { scope: 'workspace', workspaceId }) ?? null),
    [klient, workspaceId],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
        <div className="border-b border-neutral-800 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Workspace
          </div>
          <div
            title={selected?.root}
            className="truncate font-mono text-[11px] text-neutral-300"
          >
            {selected === undefined ? (
              <span className="text-neutral-600 italic">none selected</span>
            ) : (
              `${selected.name} — ${selected.root}`
            )}
          </div>
          {workspaces.isError ? <ErrorLine error={workspaces.error} /> : null}
        </div>
        <WorkspaceDirBrowser
          klient={klient}
          workspaces={workspaces.data}
          onSelect={(workspace) => {
            setWorkspaceId(workspace.id);
          }}
        />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
    </div>
  );
}
