/**
 * `SessionListWatchService` — the event plane of multi-instance session-list
 * sync.
 *
 * Several kap-server instances can share one home directory (the
 * `multi_server` experimental flag). The session list itself needs no
 * synchronization: `ISessionIndex.list()` re-enumerates the shared
 * `<home>/sessions` tree on every request, so a peer's sessions are visible on
 * the next pull. What a peer can never produce is the *event* — core events
 * are process-local. This service closes that gap locally: it watches the
 * shared sessions tree and, on any workspace/session directory appearing or
 * disappearing, publishes ONE debounced `session.list_changed` hint on this
 * instance's core `IEventService`, which the `SessionEventBroadcaster` fans
 * out live (volatile, never journaled) to every connected WS client. Clients
 * then re-pull the list — the directory scan stays the single authority, the
 * hint is pure "go refetch" advice and deliberately carries no payload.
 *
 * Two-layer topology (a root recursive watch was rejected as an event flood):
 *   - root `<home>/sessions` at depth 0: workspace directories appearing /
 *     disappearing — per-workspace watchers are added and removed here;
 *   - one depth-0 watcher per workspace directory: session directories
 *     appearing / disappearing.
 * Existing workspaces are scanned at `start()`; every watcher runs with
 * `ignoreInitial` so boot produces no hint flood.
 *
 * This is transport state (like `FsWatchBridge` / `SessionEventBroadcaster`):
 * constructed in `start.ts` when `multi_server` is on — never DI-registered —
 * and disposed during server close before the core scope goes down.
 */

import { mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type {
  HostFsChange,
  IEventService,
  IHostFsWatchHandle,
  IHostFsWatchService,
} from '@moonshot-ai/agent-core-v2';

import type { JournalLogger } from '../../transport/ws/v1/sessionEventJournal';

/** Same debounce window as the storage-byte watch layer (`fileStorageService`). */
export const SESSION_LIST_WATCH_DEBOUNCE_MS = 150;

export class SessionListWatchService {
  private readonly sessionsDir: string;
  private readonly fsWatch: IHostFsWatchService;
  private readonly events: IEventService;
  private readonly logger: JournalLogger | undefined;
  private readonly debounceMs: number;

  private rootHandle: IHostFsWatchHandle | undefined;
  /** workspaceId → handle, added/removed as workspace directories come and go. */
  private readonly workspaceHandles = new Map<string, IHostFsWatchHandle>();
  private readonly pendingWorkspaceWatchers = new Set<string>();
  private readonly removedWorkspaces = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(opts: {
    readonly sessionsDir: string;
    readonly fsWatch: IHostFsWatchService;
    readonly events: IEventService;
    readonly logger?: JournalLogger;
    /** Test seam: defaults to {@link SESSION_LIST_WATCH_DEBOUNCE_MS}. */
    readonly debounceMs?: number;
  }) {
    this.sessionsDir = opts.sessionsDir;
    this.fsWatch = opts.fsWatch;
    this.events = opts.events;
    this.logger = opts.logger;
    this.debounceMs = opts.debounceMs ?? SESSION_LIST_WATCH_DEBOUNCE_MS;
  }

  /** Resolves when the initial workspace scan is done (never rejects). */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    // Watching a not-yet-existing root would leave later first-session
    // creation (which mkdirs the whole chain) up to chokidar's nonexistent-
    // path timing; creating the dir up front removes that race. The server
    // owns this tree anyway — the first session write would create it.
    try {
      mkdirSync(this.sessionsDir, { recursive: true });
    } catch (error) {
      this.logger?.warn(
        { err: String(error) },
        'session list watch: failed to ensure sessions dir; watching anyway',
      );
    }
    this.rootHandle = this.fsWatch.watch(this.sessionsDir, { recursive: false });
    this.rootHandle.onDidChange((change) => this.onRootChange(change));
    return this.rootHandle.ready
      .catch((error: unknown) => {
        this.logger?.warn({ err: String(error) }, 'session list watch: root watcher failed to ready');
      })
      .then(() => this.scanWorkspaces());
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const handle of this.workspaceHandles.values()) handle.dispose();
    this.workspaceHandles.clear();
    this.pendingWorkspaceWatchers.clear();
    this.removedWorkspaces.clear();
    this.rootHandle?.dispose();
    this.rootHandle = undefined;
    this.started = false;
  }

  private async scanWorkspaces(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ err: String(error) }, 'session list watch: workspace scan failed');
      }
      return;
    }
    for (const entry of entries) {
      if (!this.started) return;
      if (entry.isDirectory()) await this.addWorkspaceWatcher(entry.name);
    }
  }

  /** Root depth-0 events: only directories matter — workspace ids. */
  private onRootChange(change: HostFsChange): void {
    if (change.kind !== 'directory') return;
    // depth-0 watching reports direct children only; check defensively anyway.
    const workspaceId = relative(this.sessionsDir, change.path);
    if (workspaceId === '' || workspaceId.includes(sep)) return;
    this.scheduleHint();
    if (change.action === 'created') {
      this.removedWorkspaces.delete(workspaceId);
      void this.addWorkspaceWatcher(workspaceId);
    } else if (change.action === 'deleted') {
      this.removedWorkspaces.add(workspaceId);
      this.removeWorkspaceWatcher(workspaceId);
    }
    // The hint for the root event itself already covers a workspace that
    // appeared WITH its first session inside (created between the fs event and
    // our watcher attach): one debounced hint, no missed window.
  }

  /** Per-workspace depth-0 events: only directories matter — session ids. */
  private onWorkspaceChange(change: HostFsChange): void {
    if (change.kind !== 'directory') return;
    if (change.action === 'modified') return;
    this.scheduleHint();
  }

  private async addWorkspaceWatcher(workspaceId: string): Promise<void> {
    if (this.workspaceHandles.has(workspaceId) || this.pendingWorkspaceWatchers.has(workspaceId)) return;
    this.pendingWorkspaceWatchers.add(workspaceId);
    try {
      const workspacePath = join(this.sessionsDir, workspaceId);
      const before = await this.readDirectoryNames(workspacePath);
      let handle: IHostFsWatchHandle;
      try {
        handle = this.fsWatch.watch(workspacePath, {
          recursive: false,
        });
      } catch (error) {
        this.logger?.warn(
          { workspaceId, err: String(error) },
          'session list watch: failed to watch workspace dir',
        );
        return;
      }
      if (!this.started || this.removedWorkspaces.has(workspaceId)) {
        handle.dispose();
        return;
      }
      this.workspaceHandles.set(workspaceId, handle);
      handle.onDidChange((change) => this.onWorkspaceChange(change));
      await handle.ready.catch((error: unknown) => {
        this.logger?.warn({ workspaceId, err: String(error) }, 'session list watch: workspace watcher failed to ready');
      });
      if (!this.started || this.workspaceHandles.get(workspaceId) !== handle) return;
      const after = await this.readDirectoryNames(workspacePath);
      if (!sameNames(before, after)) this.scheduleHint();
    } finally {
      this.pendingWorkspaceWatchers.delete(workspaceId);
    }
  }

  private async readDirectoryNames(path: string): Promise<Set<string>> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    } catch {
      return new Set();
    }
  }

  private removeWorkspaceWatcher(workspaceId: string): void {
    const handle = this.workspaceHandles.get(workspaceId);
    if (handle === undefined) return;
    this.workspaceHandles.delete(workspaceId);
    handle.dispose();
  }

  private scheduleHint(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.publishHint();
    }, this.debounceMs);
  }

  private publishHint(): void {
    try {
      this.events.publish({ type: 'session.list_changed', payload: {} });
    } catch (error) {
      this.logger?.warn({ err: String(error) }, 'session list watch: hint publish failed');
    }
  }
}

function sameNames(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const name of left) if (!right.has(name)) return false;
  return true;
}
