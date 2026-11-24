import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

import { join, resolve } from 'pathe';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { WORKTREE_FLAG_ID } from '#/app/worktree/worktree';
import { canonicalPath } from '#/app/worktree/worktreeCheckout';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { processStampAlive, type ProcessStamp } from '#/persistence/backends/node-fs/processLiveness';
import { projectPersistenceScope, sessionDirOf } from '#/project/sessionLifecycle/internal/addressing';

import {
  ISessionPresence,
  SESSION_PRESENCE_DIR,
  type SessionsUnder,
  type SessionsUnderOptions,
} from './sessionPresence';

const PRESENCE_MARKER_VERSION = 1;

interface PresenceMarker extends ProcessStamp {
  readonly version: number;
}

const NOOP: IDisposable = { dispose: () => {} };

interface OpenSessionEntry {
  readonly sessionDir: string;
  markerPath?: string;
  disposed: boolean;
}

export class SessionPresenceService extends Disposable implements ISessionPresence {
  declare readonly _serviceBrand: undefined;

  private readonly hostname = os.hostname();
  private readonly startedAt = Math.round(performance.timeOrigin);
  private readonly markers = new Set<string>();
  private readonly openDirs = new Map<string, number>();
  private readonly openEntries = new Set<OpenSessionEntry>();
  private disposed = false;
  private readonly exitListener = (): void => {
    for (const marker of this.markers) unlinkSilent(marker);
  };

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionIndex private readonly index: ISessionIndex,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(this.flags.onDidChange(() => this.syncMarkers()));
  }

  markOpen(sessionDir: string): IDisposable {
    if (this.disposed) return NOOP;
    const release = this.holdOpen(sessionDir);
    const entry: OpenSessionEntry = { sessionDir, disposed: false };
    this.openEntries.add(entry);
    if (this.flags.enabled(WORKTREE_FLAG_ID)) {
      this.writeMarker(entry);
    }
    return {
      dispose: () => {
        if (entry.disposed) return;
        entry.disposed = true;
        this.openEntries.delete(entry);
        release();
        this.removeMarker(entry);
      },
    };
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.openEntries) {
      entry.disposed = true;
      this.removeMarker(entry);
    }
    this.openEntries.clear();
    this.openDirs.clear();
    if (this.markers.size > 0) {
      for (const marker of this.markers) unlinkSilent(marker);
      this.markers.clear();
      process.off('exit', this.exitListener);
    }
    super.dispose();
  }

  private syncMarkers(): void {
    if (this.disposed || !this.flags.enabled(WORKTREE_FLAG_ID)) return;
    for (const entry of this.openEntries) {
      this.writeMarker(entry);
    }
  }

  private writeMarker(entry: OpenSessionEntry): void {
    if (entry.disposed || entry.markerPath !== undefined) return;
    const dir = join(entry.sessionDir, SESSION_PRESENCE_DIR);
    const marker = join(dir, `${process.pid}-${randomUUID()}.json`);
    const body: PresenceMarker = {
      version: PRESENCE_MARKER_VERSION,
      pid: process.pid,
      hostname: this.hostname,
      startedAt: this.startedAt,
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const staged = `${marker}.tmp`;
      fs.writeFileSync(staged, JSON.stringify(body));
      fs.renameSync(staged, marker);
    } catch (error) {
      this.log.warn(`cannot mark session ${entry.sessionDir} as open: ${String(error)}`);
      return;
    }
    if (this.markers.size === 0) process.on('exit', this.exitListener);
    this.markers.add(marker);
    entry.markerPath = marker;
  }

  private removeMarker(entry: OpenSessionEntry): void {
    const marker = entry.markerPath;
    if (marker === undefined) return;
    entry.markerPath = undefined;
    if (!this.markers.delete(marker)) return;
    unlinkSilent(marker);
    if (this.markers.size === 0) process.off('exit', this.exitListener);
  }

  async sessionsUnder(dir: string, options: SessionsUnderOptions = {}): Promise<SessionsUnder> {
    const roots = new Set([workspaceRootKey(dir), workspaceRootKey(await canonicalPath(this.hostFs, dir))]);
    const canonicalCwds = new Map<string, string>();
    const under = async (cwd: string): Promise<boolean> => {
      if (isUnder(workspaceRootKey(cwd), roots)) return true;
      let canonical = canonicalCwds.get(cwd);
      if (canonical === undefined) {
        canonical = workspaceRootKey(await canonicalPath(this.hostFs, cwd));
        canonicalCwds.set(cwd, canonical);
      }
      return isUnder(canonical, roots);
    };
    const openSessionIds: string[] = [];
    let closedSessionCount = 0;
    const { items } = await this.index.listRecent({ includeArchived: true });
    for (const summary of items) {
      if (summary.environmentId !== undefined && summary.environmentId !== LOCAL_ENVIRONMENT_ID) continue;
      if (summary.cwd === undefined || !(await under(summary.cwd))) continue;
      const excluded = summary.id === options.excludeSessionId;
      if (this.hasLiveMarker(summary, excluded)) openSessionIds.push(summary.id);
      else if (!excluded) closedSessionCount += 1;
    }
    return { openSessionIds, closedSessionCount };
  }

  private holdOpen(sessionDir: string): () => void {
    const key = resolve(sessionDir);
    this.openDirs.set(key, (this.openDirs.get(key) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const remaining = (this.openDirs.get(key) ?? 1) - 1;
      if (remaining === 0) this.openDirs.delete(key);
      else this.openDirs.set(key, remaining);
    };
  }

  private hasLiveMarker(summary: SessionSummary, excludeOwnMarker: boolean): boolean {
    const sessionDir = sessionDirOf(
      this.bootstrap.homeDir,
      projectPersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId),
      summary.id,
    );
    const ownCount = this.openDirs.get(resolve(sessionDir)) ?? 0;
    if (ownCount > (excludeOwnMarker ? 1 : 0)) return true;
    const dir = join(sessionDir, SESSION_PRESENCE_DIR);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return false;
    }
    let alive = false;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const markerPath = join(dir, name);
      if (excludeOwnMarker && this.markers.has(markerPath)) continue;
      const marker = readMarker(markerPath);
      if (marker === undefined) continue;
      if (processStampAlive(marker, this.hostname)) alive = true;
      else unlinkSilent(markerPath);
    }
    return alive;
  }
}

function isUnder(key: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (key === root || key.startsWith(`${root}/`)) return true;
  }
  return false;
}

function readMarker(path: string): ProcessStamp | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as Partial<PresenceMarker>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return undefined;
    return {
      pid: parsed.pid,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
      startedAt: parsed.startedAt,
    };
  } catch {
    return undefined;
  }
}

function unlinkSilent(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    return;
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionPresence,
  SessionPresenceService,
  ScopeActivation.OnDemand,
  'sessionPresence',
);
