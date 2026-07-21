/**
 * Left sidebar — two columns: the workspace registry (`IWorkspaceRegistry`)
 * and the sessions of the selected workspace (`ISessionIndex`). Clicking a
 * session opens it in the main view. Lists refresh on a slow poll only: the
 * core-event stream that used to trigger a debounced refresh went away with
 * the v2 socket (`/api/v2/ws`). Session creation goes through the v1 REST
 * endpoint.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ISessionIndex, type SessionSummary } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceRegistry, type Workspace } from '@moonshot-ai/agent-core-v2/app/workspaceRegistry/workspaceRegistry';

import { useConnection } from '../connection';
import { Badge, ErrorLine, relTime } from '../ui';

export function Sidebar({
  activeSessionId,
  onSelectSession,
}: {
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}) {
  const { klient, baseUrl, config } = useConnection();
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => klient.core(IWorkspaceRegistry).list(),
    refetchInterval: 15_000,
  });

  const sessions = useQuery({
    queryKey: ['sessions', workspaceId],
    queryFn: () =>
      klient
        .core(ISessionIndex)
        .list({ workspaceIds: workspaceId === null ? undefined : [workspaceId], includeArchived: true, limit: 200 }),
    refetchInterval: 15_000,
  });

  const sortedWorkspaces = (workspaces.data ?? []).toSorted((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  const sortedSessions = (sessions.data?.items ?? []).toSorted((a, b) => b.updatedAt - a.updatedAt);

  const createSession = async (ws: Workspace | null) => {
    const cwd = window.prompt('Working directory for the new session:', ws?.root ?? '');
    if (cwd === null || cwd.trim() === '') return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.token.trim() !== '') headers['authorization'] = `Bearer ${config.token.trim()}`;
    const res = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspace_id: ws?.id, metadata: { cwd: cwd.trim() } }),
    });
    const envelope = (await res.json()) as { code: number; msg: string; data: { id: string } };
    if (envelope.code !== 0) {
      window.alert(`create session failed: ${envelope.msg}`);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    onSelectSession(envelope.data.id);
  };

  return (
    <div className="flex h-full w-[480px] shrink-0 border-r border-neutral-800">
      {/* Workspaces */}
      <div className="flex w-1/2 flex-col border-r border-neutral-800">
        <div className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          <span>Workspaces</span>
          <button
            className="text-sky-500 hover:text-sky-400"
            title="New session (no workspace)"
            onClick={() => void createSession(null)}
          >
            +
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {workspaces.isError ? <ErrorLine error={workspaces.error} /> : null}
          {sortedWorkspaces.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              ws={ws}
              selected={ws.id === workspaceId}
              onClick={() => setWorkspaceId(ws.id)}
              onNew={() => void createSession(ws)}
            />
          ))}
          {workspaces.isLoading ? (
            <div className="px-3 py-2 text-[11px] text-neutral-600">loading…</div>
          ) : null}
        </div>
      </div>

      {/* Sessions */}
      <div className="flex w-1/2 flex-col">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          Sessions {workspaceId === null ? '(all)' : ''}
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.isError ? <ErrorLine error={sessions.error} /> : null}
          {sortedSessions.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              active={s.id === activeSessionId}
              onClick={() => onSelectSession(s.id)}
            />
          ))}
          {sessions.isLoading ? (
            <div className="px-3 py-2 text-[11px] text-neutral-600">loading…</div>
          ) : null}
          {!sessions.isLoading && sortedSessions.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-neutral-600">no sessions</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WorkspaceRow({
  ws,
  selected,
  onClick,
  onNew,
}: {
  ws: Workspace;
  selected: boolean;
  onClick: () => void;
  onNew: () => void;
}) {
  return (
    <div
      className={`group flex cursor-pointer items-center justify-between px-3 py-2 hover:bg-neutral-800/60 ${
        selected ? 'bg-neutral-800' : ''
      }`}
      onClick={onClick}
    >
      <div className="min-w-0">
        <div className="truncate text-[12px] text-neutral-200">{ws.name}</div>
        <div className="truncate text-[10px] text-neutral-500" title={ws.root}>
          {ws.root}
        </div>
      </div>
      <button
        className="ml-2 hidden shrink-0 text-sky-500 hover:text-sky-400 group-hover:block"
        title="New session in this workspace"
        onClick={(e) => {
          e.stopPropagation();
          onNew();
        }}
      >
        +
      </button>
    </div>
  );
}

function SessionRow({ s, active, onClick }: { s: SessionSummary; active: boolean; onClick: () => void }) {
  return (
    <div
      className={`cursor-pointer px-3 py-2 hover:bg-neutral-800/60 ${active ? 'bg-sky-950/60' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">
          {s.title ?? s.lastPrompt ?? s.id}
        </span>
        {s.archived ? <Badge tone="neutral">archived</Badge> : null}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-500">
        <span className="truncate font-mono">{s.id.slice(0, 12)}</span>
        <span className="shrink-0">{relTime(s.updatedAt)}</span>
      </div>
    </div>
  );
}
