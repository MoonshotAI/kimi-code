/**
 * Left sidebar — two columns: the workspace catalog (`IWorkspaceService`)
 * and the sessions of the selected workspace (`ISessionIndex`). Clicking a
 * session opens it in the main view. Lists refresh on a slow poll only: the
 * core-event stream that used to trigger a debounced refresh went away with
 * the v2 socket (`/api/v2/ws`). Session creation goes through the v1 REST
 * endpoint.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { ISessionIndex, type SessionSummary } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';
import { IWorkspaceService, type Workspace } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';

import type { InspectClient } from '../channel';
import { useConnection } from '../connection';
import { Badge, ErrorLine, relTime } from '../ui';

/**
 * Default model for a fresh session: the configured global `defaultModel`
 * first (the same fallback the profile bind uses), then the first connected
 * provider's `default_model`. `undefined` means the server has nothing to
 * offer — the session stays model-less and the chat surfaces
 * `model.not_configured` as before.
 */
async function resolveDefaultModel(klient: InspectClient): Promise<string | undefined> {
  const configured: unknown = await klient.core(IConfigService).get('defaultModel');
  if (typeof configured === 'string' && configured !== '') return configured;
  const providers = await klient.core(IModelCatalog).listProviders();
  const withDefault = providers.filter((p) => p.default_model !== undefined);
  return (withDefault.find((p) => p.status === 'connected') ?? withDefault[0])?.default_model;
}

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
    queryFn: () => klient.core(IWorkspaceService).list(),
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
    // With a workspace, the server derives workDir from workspace.root, so no cwd is needed.
    let body: string;
    if (ws !== null) {
      body = JSON.stringify({ workspace_id: ws.id });
    } else {
      const cwd = window.prompt('Working directory for the new session:', '');
      if (cwd === null || cwd.trim() === '') return;
      body = JSON.stringify({ metadata: { cwd: cwd.trim() } });
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.token.trim() !== '') headers['authorization'] = `Bearer ${config.token.trim()}`;
    const res = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers,
      body,
    });
    const envelope = (await res.json()) as { code: number; msg: string; data: { id: string } };
    if (envelope.code !== 0) {
      window.alert(`create session failed: ${envelope.msg}`);
      return;
    }
    const sessionId = envelope.data.id;
    // The REST create route ignores agent_config, so bind the default model
    // over the channel — the same resume + setModel path the Model Catalog's
    // "+ Session" button uses. Best-effort: a failure leaves the session
    // model-less instead of blocking the creation flow.
    try {
      const model = await resolveDefaultModel(klient);
      if (model !== undefined) {
        await klient.core(ISessionLifecycleService).resume(sessionId);
        await klient.session(sessionId).agent('main').service(IAgentProfileService).setModel(model);
      }
    } catch (error) {
      console.warn('failed to set the default model on the new session', error);
    }
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
    onSelectSession(sessionId);
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
