/**
 * Left sidebar — a spreadsheet-like session table backed by the v2 REST
 * list (`GET /api/v2/sessions`, see `src/sessions/api.ts`). Preset views
 * (`src/sessions/views.ts`) map onto the endpoint's status / archived / git
 * query conditions; column visibility and the active view persist to
 * localStorage; sort clicks only offer what the server sorts. Pagination is
 * the endpoint's opaque cursor (Load more), with a slow poll on top. Live
 * activity frames (`useSessionActivities`) override the REST status badge.
 * Session creation still goes through the v1 REST endpoint.
 */

import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/sessionLifecycle';
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
  fetchV2SessionsPage,
  type V2ActivityStatus,
  type V2Session,
  type V2SessionSort,
} from '../sessions/api';
import { SESSION_VIEWS, sessionViewById } from '../sessions/views';
import { Badge, ErrorLine, relTime } from '../ui';

const STORAGE_KEY = 'kimi-inspect.session-table';

const DEFAULT_WIDTH = 560;
const MIN_WIDTH = 380;
const MAX_WIDTH = 960;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type ColumnId = 'status' | 'title' | 'workspace' | 'branch' | 'pr' | 'updated' | 'created';

interface ColumnDef {
  readonly id: ColumnId;
  readonly label: string;
  readonly width: string;
  /** Title is the identity column and cannot be hidden. */
  readonly hideable: boolean;
}

const COLUMNS: readonly ColumnDef[] = [
  { id: 'status', label: 'Status', width: '76px', hideable: true },
  { id: 'title', label: 'Title', width: 'minmax(120px, 1fr)', hideable: false },
  { id: 'workspace', label: 'Workspace', width: '110px', hideable: true },
  { id: 'branch', label: 'Branch', width: '100px', hideable: true },
  { id: 'pr', label: 'PR', width: '56px', hideable: true },
  { id: 'updated', label: 'Updated', width: '72px', hideable: true },
  { id: 'created', label: 'Created', width: '72px', hideable: true },
];

function defaultColumns(includeGit: boolean): readonly ColumnId[] {
  return includeGit
    ? ['status', 'title', 'workspace', 'branch', 'pr', 'updated']
    : ['status', 'title', 'workspace', 'updated'];
}

// ---------------------------------------------------------------------------
// Persisted panel prefs
// ---------------------------------------------------------------------------

interface PanelPrefs {
  readonly view?: string;
  /** Visible columns per view id; absent = the view's defaults. */
  readonly columns?: Record<string, readonly ColumnId[]>;
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
  const visibleColumns = prefs.columns?.[view.id] ?? defaultColumns(view.includeGit === true);
  const width = prefs.width ?? DEFAULT_WIDTH;

  const updatePrefs = (patch: PanelPrefs) => {
    setPrefs((prev) => {
      const next: PanelPrefs = { ...prev, ...patch };
      writePrefs(next);
      return next;
    });
  };

  const toggleColumn = (column: ColumnId) => {
    const next = visibleColumns.includes(column)
      ? visibleColumns.filter((c) => c !== column)
      : COLUMNS.map((c) => c.id).filter((c) => c === column || visibleColumns.includes(c));
    updatePrefs({ columns: { ...prefs.columns, [view.id]: next } });
  };

  const token = config.token.trim();

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => klient.core(IWorkspaceService).list(),
    refetchInterval: 15_000,
  });
  const workspaceNames = useMemo(
    () => new Map((workspaces.data ?? []).map((ws) => [ws.id, ws.name] as const)),
    [workspaces.data],
  );

  const sessions = useInfiniteQuery({
    queryKey: ['v2-sessions', view.id, sort],
    queryFn: ({ pageParam }) =>
      fetchV2SessionsPage({
        baseUrl,
        token: token === '' ? undefined : token,
        statuses: view.statuses,
        archived: view.archived,
        includeGit: view.includeGit,
        sort,
        pageSize: 50,
        pageToken: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextPageToken,
    refetchInterval: 15_000,
  });

  const items = useMemo(() => sessions.data?.pages.flatMap((page) => page.items) ?? [], [sessions.data]);

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
        const summary = await klient.core(ISessionIndex).get(sessionId);
        if (summary !== undefined) {
          await klient
            .workspace(summary.workspaceId)
            .service(ISessionLifecycleService)
            .resume(sessionId);
        }
        await klient.session(sessionId).agent('main').service(IAgentProfileService).setModel(model);
      }
    } catch (error) {
      console.warn('failed to set the default model on the new session', error);
    }
    await queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
    onSelectSession(sessionId);
  };

  const visibleDefs = COLUMNS.filter((c) => visibleColumns.includes(c.id));
  const gridTemplate = visibleDefs.map((c) => c.width).join(' ');

  const onSortClick = (column: ColumnId) => {
    if (column === 'updated') {
      setSort((s) => (s === 'meta.updated_at_desc' ? 'meta.updated_at_asc' : 'meta.updated_at_desc'));
    } else if (column === 'created') {
      setSort('meta.created_at_desc');
    }
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

      {/* Toolbar: new session + column config */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <NewSessionMenu workspaces={workspaces.data ?? []} onCreate={createSession} />
        <ColumnMenu
          visible={visibleColumns}
          onToggle={toggleColumn}
        />
      </div>

      {/* Header row */}
      <div
        className="grid items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-500"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {visibleDefs.map((c) => {
          const sortable = c.id === 'updated' || c.id === 'created';
          const activeSort =
            (c.id === 'updated' && sort !== 'meta.created_at_desc') ||
            (c.id === 'created' && sort === 'meta.created_at_desc');
          return (
            <div
              key={c.id}
              className={`truncate ${sortable ? 'cursor-pointer select-none hover:text-neutral-300' : ''} ${
                activeSort ? 'text-neutral-300' : ''
              }`}
              onClick={sortable ? () => onSortClick(c.id) : undefined}
              title={sortable ? 'Click to change sort' : undefined}
            >
              {c.label}
              {activeSort ? (sort === 'meta.updated_at_asc' ? ' ↑' : ' ↓') : null}
            </div>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {sessions.isError ? <ErrorLine error={sessions.error} /> : null}
        <SessionRows
          items={items}
          gridTemplate={gridTemplate}
          visibleDefs={visibleDefs}
          groupByWorkspace={view.groupByWorkspace === true}
          workspaceNames={workspaceNames}
          activeSessionId={activeSessionId}
          activityOf={(id) => activities.get(id)}
          onSelect={onSelectSession}
        />
        {sessions.isLoading ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600">loading…</div>
        ) : null}
        {!sessions.isLoading && items.length === 0 && !sessions.isError ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600">no sessions</div>
        ) : null}
        {sessions.hasNextPage ? (
          <button
            className="w-full border-t border-neutral-800 px-3 py-1.5 text-[11px] text-sky-500 hover:bg-neutral-800/60 hover:text-sky-400"
            disabled={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
          >
            {sessions.isFetchingNextPage ? 'loading…' : 'Load more'}
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
// Rows
// ---------------------------------------------------------------------------

function SessionRows({
  items,
  gridTemplate,
  visibleDefs,
  groupByWorkspace,
  workspaceNames,
  activeSessionId,
  activityOf,
  onSelect,
}: {
  items: readonly V2Session[];
  gridTemplate: string;
  visibleDefs: readonly ColumnDef[];
  groupByWorkspace: boolean;
  workspaceNames: ReadonlyMap<string, string>;
  activeSessionId: string | null;
  activityOf: (sessionId: string) => SessionWorkFacts | undefined;
  onSelect: (sessionId: string) => void;
}) {
  if (!groupByWorkspace) {
    return (
      <>
        {items.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            gridTemplate={gridTemplate}
            visibleDefs={visibleDefs}
            workspaceNames={workspaceNames}
            active={s.id === activeSessionId}
            activity={activityOf(s.id)}
            onClick={() => onSelect(s.id)}
          />
        ))}
      </>
    );
  }

  const groups = new Map<string, V2Session[]>();
  for (const s of items) {
    const list = groups.get(s.workspace.id);
    if (list === undefined) groups.set(s.workspace.id, [s]);
    else list.push(s);
  }
  return (
    <>
      {[...groups.entries()].map(([workspaceId, sessions]) => (
        <div key={workspaceId}>
          <div className="sticky top-0 border-b border-neutral-800 bg-neutral-900 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {workspaceNames.get(workspaceId) ?? sessions[0]?.workspace.cwd ?? workspaceId}
            <span className="ml-1 text-neutral-600">{sessions.length}</span>
          </div>
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              gridTemplate={gridTemplate}
              visibleDefs={visibleDefs}
              workspaceNames={workspaceNames}
              active={s.id === activeSessionId}
              activity={activityOf(s.id)}
              onClick={() => onSelect(s.id)}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function SessionRow({
  s,
  gridTemplate,
  visibleDefs,
  workspaceNames,
  active,
  activity,
  onClick,
}: {
  s: V2Session;
  gridTemplate: string;
  visibleDefs: readonly ColumnDef[];
  workspaceNames: ReadonlyMap<string, string>;
  active: boolean;
  activity?: SessionWorkFacts | undefined;
  onClick: () => void;
}) {
  const status = liveStatus(activity) ?? s.activity.status;
  const cell = (id: ColumnId): React.ReactNode => {
    switch (id) {
      case 'status':
        return status === 'idle' ? (
          <span className="text-neutral-700">—</span>
        ) : (
          <Badge tone={STATUS_TONES[status]}>{status}</Badge>
        );
      case 'title':
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">
                {s.meta.title ?? s.meta.lastPrompt ?? s.id}
              </span>
              {s.meta.archived ? <Badge tone="neutral">archived</Badge> : null}
            </div>
            <div className="truncate font-mono text-[10px] text-neutral-600">
              {s.id.slice(0, 12)}
            </div>
          </div>
        );
      case 'workspace':
        return (
          <span className="truncate" title={s.workspace.cwd ?? s.workspace.id}>
            {workspaceNames.get(s.workspace.id) ?? s.workspace.cwd ?? s.workspace.id.slice(0, 8)}
          </span>
        );
      case 'branch':
        return s.git !== undefined && s.git.branch !== null ? (
          <span className="truncate font-mono" title={s.git.branch}>
            {s.git.branch}
          </span>
        ) : (
          <span className="text-neutral-700">—</span>
        );
      case 'pr':
        return s.git !== undefined && s.git.pullRequest !== null ? (
          <a
            className="truncate text-sky-500 hover:text-sky-400"
            href={s.git.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            #{s.git.pullRequest.number}
          </a>
        ) : (
          <span className="text-neutral-700">—</span>
        );
      case 'updated':
        return <span className="text-neutral-500">{relTime(s.meta.updatedAt)}</span>;
      case 'created':
        return <span className="text-neutral-500">{relTime(s.meta.createdAt)}</span>;
    }
  };
  return (
    <div
      className={`grid cursor-pointer items-center gap-2 border-b border-neutral-800/50 px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-800/60 ${
        active ? 'bg-sky-950/60' : ''
      }`}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={onClick}
    >
      {visibleDefs.map((c) => (
        <div key={c.id} className="min-w-0 truncate">
          {cell(c.id)}
        </div>
      ))}
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

function ColumnMenu({
  visible,
  onToggle,
}: {
  visible: readonly ColumnId[];
  onToggle: (column: ColumnId) => void;
}) {
  const { open, toggle, close } = useDropdown();
  const hideable = COLUMNS.filter((c) => c.hideable);
  return (
    <div className="relative">
      <button
        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800"
        onClick={toggle}
      >
        Columns
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute right-0 z-20 mt-1 w-40 rounded border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
            {hideable.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800"
              >
                <input
                  type="checkbox"
                  checked={visible.includes(c.id)}
                  onChange={() => onToggle(c.id)}
                />
                {c.label}
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
