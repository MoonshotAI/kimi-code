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
import { useEffect, useState, type ReactNode } from 'react';

import { useConnection } from '../connection';
import { fetchWorkspaceSnapshot } from '../snapshots/api';
import { Badge, ErrorLine } from '../ui';
import { WorkspaceDirBrowser } from './WorkspaceDirBrowser';

export function WorkspaceServicesView() {
  const { klient, baseUrl } = useConnection();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const workspaces = useQuery({
    queryKey: ['workspaces', klient.baseUrl],
    queryFn: () => klient.core(IWorkspaceService).list(),
  });
  const snapshot = useQuery({
    queryKey: ['workspace-snapshot', klient.baseUrl, workspaceId],
    queryFn: () => fetchWorkspaceSnapshot(klient, workspaceId as string),
    enabled: workspaceId !== null,
    refetchInterval: 1_000,
  });

  useEffect(() => {
    setWorkspaceId(null);
  }, [baseUrl]);

  const selected = (workspaces.data ?? []).find((ws) => ws.id === workspaceId);
  const data = snapshot.data;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
        <div className="border-b border-neutral-800 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Workspace
          </div>
          <div title={selected?.root} className="truncate font-mono text-[11px] text-neutral-300">
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
          onSelect={(workspace) => setWorkspaceId(workspace.id)}
        />
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        {workspaceId === null ? (
          <div className="flex h-full items-center justify-center text-[12px] text-neutral-600 italic">
            select a workspace to inspect
          </div>
        ) : snapshot.isError ? (
          <ErrorLine error={snapshot.error} />
        ) : data === undefined ? (
          <div className="text-[12px] text-neutral-600">loading workspace snapshot…</div>
        ) : (
          <div className="space-y-4">
            <SnapshotPanel title="Workspace">
              <SnapshotRow label="id" value={data.metadata.id} />
              <SnapshotRow label="name" value={data.metadata.name} />
              <SnapshotRow label="root" value={data.metadata.root} />
              <SnapshotRow label="lifecycle" value={<Badge tone="sky">{data.lifecycle}</Badge>} />
            </SnapshotPanel>
            <SnapshotPanel title="Program">
              <SnapshotRow label="binding" value={`${data.program.binding.workspaceId} / ${data.program.binding.runtimeId}`} />
              <SnapshotRow label="status" value={<Badge tone={data.program.status === 'ready' ? 'green' : 'neutral'}>{data.program.status}</Badge>} />
              <SnapshotRow label="ready" value={String(data.program.ready)} />
              <SnapshotRow label="generation" value={data.program.generation ?? 'unavailable'} />
              <SnapshotRow label="trusted" value={data.program.trusted === undefined ? 'unknown' : String(data.program.trusted)} />
              <SnapshotRow label="skills" value={`${data.program.catalog.skills.total} total / ${data.program.catalog.skills.invocable} invocable / ${data.program.catalog.skills.skipped} skipped`} />
              <SnapshotRow label="agent profiles" value={String(data.program.catalog.agentProfiles)} />
              <SnapshotRow label="MCP servers" value={String(data.program.catalog.mcpServers)} />
            </SnapshotPanel>
            <SnapshotPanel title="Runtimes">
              {data.runtimes.runtimes.length === 0 ? (
                <div className="text-[11px] text-neutral-600">no current generations</div>
              ) : data.runtimes.runtimes.map((runtime) => (
                <div key={`${runtime.runtimeId}:${runtime.generation}`} className="rounded border border-neutral-800 bg-neutral-950/40 p-2">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[12px] text-neutral-200">{runtime.runtimeId}</span>
                    <Badge tone={runtime.status === 'ready' ? 'green' : 'neutral'}>{runtime.status}</Badge>
                  </div>
                  <SnapshotRow label="generation" value={runtime.generation} />
                  <SnapshotRow label="capabilities" value={runtime.capabilities.join(', ') || 'none'} />
                </div>
              ))}
            </SnapshotPanel>
            <SnapshotPanel title="Source provenance">
              <SnapshotRow label="skills" value={data.program.sources.skills.map((source) => `${source.source}:${source.count}`).join(', ') || 'none'} />
              <SnapshotRow label="skill roots" value={data.program.sources.skillRoots.join(', ') || 'none'} />
              <SnapshotRow label="agent profiles" value={data.program.sources.agentProfiles.map((source) => `${source.sourceId}:${source.profiles.join('|')}`).join(', ') || 'none'} />
              <SnapshotRow label="instructions" value={data.program.sources.instructionPaths.join(', ') || 'none'} />
              <SnapshotRow label="MCP" value={data.program.sources.mcpServers.join(', ') || 'none'} />
            </SnapshotPanel>
          </div>
        )}
      </div>
    </div>
  );
}

function SnapshotPanel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-900/30 p-3">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">{title}</h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function SnapshotRow({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 text-[11px]">
      <span className="text-neutral-600">{label}</span>
      <span className="min-w-0 break-all font-mono text-neutral-300">{value}</span>
    </div>
  );
}
