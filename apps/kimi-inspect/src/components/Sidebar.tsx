/**
 * Left sidebar — a single-column workspace → session tree backed by the v2
 * list's grouped projection (`GET /api/v2/sessions?view=by_workspace`, see
 * `src/sessions/api.ts`): one request returns every workspace with a matching
 * session, each carrying its first `group.page_size` sessions under the
 * requested sort plus the workspace's full matching total. Preset views
 * (`src/sessions/views.ts`) map onto the endpoint's status / archived / git
 * query conditions; the active view, collapsed workspaces, and the panel
 * width persist to localStorage. Group pagination is the endpoint's opaque
 * cursor (Load more), with a slow poll on top; a workspace whose total
 * outruns the served slice expands inline into the flat per-workspace
 * listing. Live activity frames (`useSessionActivities`) override the REST
 * status badge. Session creation still goes through the v1 REST endpoint.
 */

import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import {
  IWorkspaceService,
  type Workspace,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { SessionWorkFacts } from '../activity/store';
import { useSessionActivities } from '../activity/useSessionActivity';
import type { InspectClient } from '../channel';
import { useConnection } from '../connection';
import {
  fetchV2SessionGroups,
  fetchV2SessionsPage,
  type V2ActivityStatus,
  type V2Session,
  type V2SessionGroup,
  type V2SessionSort,
} from '../sessions/api';
import { SESSION_VIEWS, sessionViewById, type SessionView } from '../sessions/views';
import { Badge, ErrorLine, relTime } from '../ui';

const STORAGE_KEY = 'kimi-inspect.session-table';

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;
const GROUP_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Persisted panel prefs
// ---------------------------------------------------------------------------

interface PanelPrefs {
  readonly view?: string;
  /** Collapsed workspace ids; absent = everything expanded. */
  readonly collapsed?: readonly string[];
  readonly width?: number;
}

function readPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) return JSON.parse(raw) as PanelPrefs;
  } catch {
    // corrupt storage — fall through to defaults
  }
  return {};
}

function writePrefs(prefs: PanelPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// ---------------------------------------------------------------------------
// Live status override (mirrors the server's mapActivityStatus)
// ---------------------------------------------------------------------------

function liveStatus(facts: SessionWorkFacts | undefined): V2ActivityStatus | undefined {
  if (facts === undefined) return undefined;
  if (facts.pendingInteraction === 'approval') return 'approval';
  if (facts.pendingInteraction === 'question') return 'question';
  if (facts.busy || facts.mainTurnActive) return 'running';
  if (facts.lastTurnReason === 'failed') return 'failed';
  return 'idle';
}

const STATUS_TONES: Record<V2ActivityStatus, 'green' | 'amber' | 'sky' | 'red' | 'neutral'> = {
  running: 'green',
  approval: 'amber',
  question: 'sky',
  failed: 'red',
  idle: 'neutral',
};

const SORTS: readonly { readonly id: V2SessionSort; readonly label: string }[] = [
  { id: 'meta.updated_at_desc', label: 'Updated ↓' },
  { id: 'meta.updated_at_asc', label: 'Updated ↑' },
  { id: 'meta.created_at_desc', label: 'Created ↓' },
];

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

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({
  activeSessionId,
  onSelectSession,
}: {
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
}) {
  const { klient, baseUrl, config } = useConnection();
  const queryClient = useQueryClient();
  const activities = useSessionActivities();

  const [prefs, setPrefs] = useState<PanelPrefs>(readPrefs);
  const view = sessionViewById(prefs.view);
  const [sort, setSort] = useState<V2SessionSort>('meta.updated_at_desc');
  const width = prefs.width ?? DEFAULT_WIDTH;
  const collapsed = useMemo(() => new Set(prefs.collapsed ?? []), [prefs.collapsed]);

  const updatePrefs = (patch: PanelPrefs) => {
    setPrefs((prev) => {
      const next: PanelPrefs = { ...prev, ...patch };
      writePrefs(next);
      return next;
    });
  };

  const toggleCollapsed = (workspaceId: string) => {
    const next = new Set(collapsed);
    if (next.has(workspaceId)) next.delete(workspaceId);
    else next.add(workspaceId);
    updatePrefs({ collapsed: [...next] });
  };

  const token = config.token.trim();
  const authToken = token === '' ? undefined : token;

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => klient.core(IWorkspaceService).list(),
    refetchInterval: 15_000,
  });
  const workspaceNames = useMemo(
    () => new Map((workspaces.data ?? []).map((ws) => [ws.id, ws.name] as const)),
    [workspaces.data],
  );

  const groups = useInfiniteQuery({
    queryKey: ['v2-sessions', 'tree', view.id, sort],
    queryFn: ({ pageParam }) =>
      fetchV2SessionGroups({
        baseUrl,
        token: authToken,
        statuses: view.statuses,
        archived: view.archived,
        includeGit: view.includeGit,
        sort,
        pageSize: 50,
        groupPageSize: GROUP_PAGE_SIZE,
        pageToken: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextPageToken,
    refetchInterval: 15_000,
  });

  const groupList = useMemo(
    () => groups.data?.pages.flatMap((page) => page.groups) ?? [],
    [groups.data],
  );

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
    if (token !== '') headers['authorization'] = `Bearer ${token}`;
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
        await klient.core(ISessionManager).resume(sessionId);
        await klient.session(sessionId).agent('main').service(IAgentProfileService).setModel(model);
      }
    } catch (error) {
      console.warn('failed to set the default model on the new session', error);
    }
    await queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
    onSelectSession(sessionId);
  };

  const cycleSort = () => {
    const index = SORTS.findIndex((s) => s.id === sort);
    setSort(SORTS[(index + 1) % SORTS.length]!.id);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX));
      setPrefs((prev) => ({ ...prev, width: next }));
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX));
      updatePrefs({ width: next });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-neutral-800"
      style={{ width }}
    >
      {/* View tabs */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-800 px-2 py-1.5">
        {SESSION_VIEWS.map((v) => (
          <button
            key={v.id}
            className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${
              v.id === view.id
                ? 'bg-neutral-800 font-medium text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => updatePrefs({ view: v.id })}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Toolbar: new session + sort */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <NewSessionMenu workspaces={workspaces.data ?? []} onCreate={createSession} />
        <button
          className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800"
          title="Click to change sort"
          onClick={cycleSort}
        >
          {SORTS.find((s) => s.id === sort)?.label}
        </button>
      </div>

      {/* Tree body */}
      <div className="flex-1 overflow-y-auto">
        {groups.isError ? <ErrorLine error={groups.error} /> : null}
        {groupList.map((group) => (
          <WorkspaceNode
            key={group.workspace.id}
            group={group}
            view={view}
            sort={sort}
            collapsed={collapsed.has(group.workspace.id)}
            onToggleCollapsed={() => toggleCollapsed(group.workspace.id)}
            workspaceNames={workspaceNames}
            activeSessionId={activeSessionId}
            activityOf={(id) => activities.get(id)}
            onSelect={onSelectSession}
            baseUrl={baseUrl}
            token={authToken}
          />
        ))}
        {groups.isLoading ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600">loading…</div>
        ) : null}
        {!groups.isLoading && groupList.length === 0 && !groups.isError ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600">no sessions</div>
        ) : null}
        {groups.hasNextPage ? (
          <button
            className="w-full border-t border-neutral-800 px-3 py-1.5 text-[11px] text-sky-500 hover:bg-neutral-800/60 hover:text-sky-400"
            disabled={groups.isFetchingNextPage}
            onClick={() => void groups.fetchNextPage()}
          >
            {groups.isFetchingNextPage ? 'loading…' : 'Load more workspaces'}
          </button>
        ) : null}
      </div>

      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-sky-700/50"
        onMouseDown={startResize}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

function WorkspaceNode({
  group,
  view,
  sort,
  collapsed,
  onToggleCollapsed,
  workspaceNames,
  activeSessionId,
  activityOf,
  onSelect,
  baseUrl,
  token,
}: {
  group: V2SessionGroup;
  view: SessionView;
  sort: V2SessionSort;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  workspaceNames: ReadonlyMap<string, string>;
  activeSessionId: string | null;
  activityOf: (sessionId: string) => SessionWorkFacts | undefined;
  onSelect: (sessionId: string) => void;
  baseUrl: string;
  token?: string | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const hasMore = group.total > group.sessions.length;
  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-1.5 border-b border-neutral-800 px-2 py-1.5 select-none hover:bg-neutral-800/60"
        onClick={onToggleCollapsed}
        title={group.workspace.cwd ?? group.workspace.id}
      >
        <span className="w-3 shrink-0 text-center text-[9px] text-neutral-600">
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-neutral-300">
          {workspaceNames.get(group.workspace.id) ?? group.workspace.cwd ?? group.workspace.id}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-600">{group.total}</span>
      </div>
      {collapsed ? null : (
        <>
          {showAll ? null : (
            <>
              {group.sessions.map((s) => (
                <SessionNode
                  key={s.id}
                  s={s}
                  active={s.id === activeSessionId}
                  activity={activityOf(s.id)}
                  onClick={() => onSelect(s.id)}
                />
              ))}
              {hasMore ? (
                <button
                  className="w-full border-b border-neutral-800/50 py-1 pl-6 text-left text-[10px] text-sky-500 hover:bg-neutral-800/60 hover:text-sky-400"
                  onClick={() => setShowAll(true)}
                >
                  Show all {group.total}…
                </button>
              ) : null}
            </>
          )}
          {showAll ? (
            <FullGroupList
              workspaceId={group.workspace.id}
              view={view}
              sort={sort}
              baseUrl={baseUrl}
              token={token}
              activeSessionId={activeSessionId}
              activityOf={activityOf}
              onSelect={onSelect}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The flat per-workspace listing behind "Show all" — pages the ungrouped
 * projection filtered to this workspace, so sessions beyond the grouped
 * slice stay reachable.
 */
function FullGroupList({
  workspaceId,
  view,
  sort,
  baseUrl,
  token,
  activeSessionId,
  activityOf,
  onSelect,
}: {
  workspaceId: string;
  view: SessionView;
  sort: V2SessionSort;
  baseUrl: string;
  token?: string | undefined;
  activeSessionId: string | null;
  activityOf: (sessionId: string) => SessionWorkFacts | undefined;
  onSelect: (sessionId: string) => void;
}) {
  const sessions = useInfiniteQuery({
    queryKey: ['v2-sessions', 'tree-full', workspaceId, view.id, sort],
    queryFn: ({ pageParam }) =>
      fetchV2SessionsPage({
        baseUrl,
        token,
        workspaceIds: [workspaceId],
        statuses: view.statuses,
        archived: view.archived,
        includeGit: view.includeGit,
        sort,
        pageSize: 50,
        pageToken: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextPageToken,
  });
  const seen = new Set<string>();
  const items = (sessions.data?.pages.flatMap((page) => page.items) ?? []).filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  return (
    <div className="bg-neutral-950/40">
      {items.map((s) => (
        <SessionNode
          key={s.id}
          s={s}
          active={s.id === activeSessionId}
          activity={activityOf(s.id)}
          onClick={() => onSelect(s.id)}
        />
      ))}
      {sessions.isLoading ? (
        <div className="py-1 pl-6 text-[10px] text-neutral-600">loading…</div>
      ) : null}
      {sessions.hasNextPage ? (
        <button
          className="w-full py-1 pl-6 text-left text-[10px] text-sky-500 hover:bg-neutral-800/60 hover:text-sky-400"
          disabled={sessions.isFetchingNextPage}
          onClick={() => void sessions.fetchNextPage()}
        >
          {sessions.isFetchingNextPage ? 'loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}

function SessionNode({
  s,
  active,
  activity,
  onClick,
}: {
  s: V2Session;
  active: boolean;
  activity?: SessionWorkFacts | undefined;
  onClick: () => void;
}) {
  const status = liveStatus(activity) ?? s.activity.status;
  return (
    <div
      className={`cursor-pointer border-b border-neutral-800/50 py-1 pr-2 pl-6 hover:bg-neutral-800/60 ${
        active ? 'bg-sky-950/60' : ''
      }`}
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5">
        {status === 'idle' ? null : <Badge tone={STATUS_TONES[status]}>{status}</Badge>}
        <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">
          {s.meta.title ?? s.meta.lastPrompt ?? s.id}
        </span>
        {s.meta.archived ? <Badge tone="neutral">archived</Badge> : null}
        <span className="shrink-0 text-[10px] text-neutral-500">{relTime(s.meta.updatedAt)}</span>
      </div>
      <div className="flex items-center gap-2 truncate font-mono text-[10px] text-neutral-600">
        <span className="truncate">{s.id.slice(0, 12)}</span>
        {s.git !== undefined && s.git.branch !== null ? (
          <span className="truncate" title={s.git.branch}>
            {s.git.branch}
          </span>
        ) : null}
        {s.git !== undefined && s.git.pullRequest !== null ? (
          <a
            className="shrink-0 text-sky-500 hover:text-sky-400"
            href={s.git.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            #{s.git.pullRequest.number}
          </a>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar dropdowns
// ---------------------------------------------------------------------------

function useDropdown(): { open: boolean; toggle: () => void; close: () => void } {
  const [open, setOpen] = useState(false);
  return {
    open,
    toggle: () => setOpen((v) => !v),
    close: () => setOpen(false),
  };
}

function NewSessionMenu({
  workspaces,
  onCreate,
}: {
  workspaces: readonly Workspace[];
  onCreate: (ws: Workspace | null) => Promise<void>;
}) {
  const { open, toggle, close } = useDropdown();
  return (
    <div className="relative">
      <button
        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
        onClick={toggle}
      >
        + New session
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute left-0 z-20 mt-1 w-64 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                className="block w-full truncate px-3 py-1.5 text-left text-[11px] text-neutral-200 hover:bg-neutral-800"
                title={ws.root}
                onClick={() => {
                  close();
                  void onCreate(ws);
                }}
              >
                {ws.name}
              </button>
            ))}
            <button
              className="block w-full border-t border-neutral-800 px-3 py-1.5 text-left text-[11px] text-neutral-400 hover:bg-neutral-800"
              onClick={() => {
                close();
                void onCreate(null);
              }}
            >
              No workspace (prompt for cwd)…
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
