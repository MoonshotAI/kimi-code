import {
  IAgentLifecycleService,
  IAgentLoopService,
  IConfigService,
  IFlagService,
  ISessionActivityView,
  ISessionContext,
  ISessionManager,
  ISessionTerminalService,
  closeSessionById,
  getLiveSessionById,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { LiveSession, LiveSessionLimits as WireLiveSessionLimits } from '../../protocol/rest-session';
import type { SessionClosedReason } from '../../transport/ws/v1/events';
import type { JournalLogger } from '../../transport/ws/v1/sessionEventJournal';
import {
  SERVER_SECTION,
  resolveLiveSessionLimits,
  type LiveSessionLimits,
  type ServerConfig,
} from './configSection';
import { WEB_MULTI_SESSION_FLAG_ID } from './flag';

const MIN_SWEEP_INTERVAL_MS = 5_000;
const MAX_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_EVICTION_GRACE_MS = 60_000;

interface LiveEntry {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly resumedAt: number;
  lastActivityAt: number;
  readonly activitySubscription: IDisposable;
}

export interface LiveSessionRegistryDeps {
  readonly core: Scope;
  readonly subscriberCount: (sessionId: string) => number;
  readonly announceClosed: (sessionId: string, workspaceId: string, reason: SessionClosedReason) => void;
  readonly logger?: JournalLogger;
  readonly sweepIntervalMs?: number;
  readonly evictionGraceMs?: number;
  readonly now?: () => number;
}

export interface CapacityReservation {
  readonly available: boolean;
  release(): void;
}

export class LiveSessionRegistry {
  private readonly entries = new Map<string, LiveEntry>();
  private readonly closing = new Map<string, SessionClosedReason>();
  private readonly deleting = new Set<string>();
  private readonly subscriptions: IDisposable[] = [];
  private readonly now: () => number;
  private limits: LiveSessionLimits = resolveLiveSessionLimits(undefined);
  private readonly evictionGraceMs: number;
  private reserved = 0;
  private quotaQueue: Promise<unknown> = Promise.resolve();
  private lastWarnedExcess = 0;
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: LiveSessionRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.evictionGraceMs = deps.evictionGraceMs ?? DEFAULT_EVICTION_GRACE_MS;
    const accessor = deps.core.accessor;
    const config = accessor.get(IConfigService);
    const readLimits = (): void => {
      this.limits = resolveLiveSessionLimits(config.get<ServerConfig | undefined>(SERVER_SECTION));
    };
    readLimits();
    void config.ready.then(() => {
      if (!this.disposed) readLimits();
    }, () => undefined);
    this.subscriptions.push(
      config.onDidSectionChange((event) => {
        if (event.domain !== SERVER_SECTION) return;
        this.limits = resolveLiveSessionLimits(event.value as ServerConfig | undefined);
        if (this.timer !== undefined) {
          this.stopTimer();
          this.start();
        }
      }),
    );
    const manager = accessor.get(ISessionManager);
    for (const handle of manager.list()) this.track(handle);
    if (manager.onDidCreateSession !== undefined) {
      this.subscriptions.push(
        manager.onDidCreateSession((event) => {
          this.track(event.handle);
        }),
      );
    }
    if (manager.onDidCloseSession !== undefined) {
      this.subscriptions.push(
        manager.onDidCloseSession(({ sessionId }) => {
          this.untrack(sessionId, true);
        }),
      );
    }
    if (manager.onDidArchiveSession !== undefined) {
      this.subscriptions.push(
        manager.onDidArchiveSession(({ sessionId }) => {
          this.untrack(sessionId, false);
        }),
      );
    }
  }

  enabled(): boolean {
    return this.deps.core.accessor.get(IFlagService).enabled(WEB_MULTI_SESSION_FLAG_ID);
  }

  start(): void {
    if (this.disposed || this.timer !== undefined) return;
    const interval =
      this.deps.sweepIntervalMs ??
      Math.min(
        MAX_SWEEP_INTERVAL_MS,
        Math.max(MIN_SWEEP_INTERVAL_MS, Math.floor(this.limits.sessionIdleTimeoutMs / 4)),
      );
    this.timer = setInterval(() => {
      void this.sweep();
    }, interval);
    this.timer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    await this.sweeping?.catch(() => undefined);
    await this.quotaQueue;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    for (const entry of this.entries.values()) entry.activitySubscription.dispose();
    this.entries.clear();
    this.closing.clear();
    this.deleting.clear();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  wireLimits(): WireLiveSessionLimits {
    return {
      max_live_sessions: this.limits.maxLiveSessions,
      session_idle_timeout_ms: this.limits.sessionIdleTimeoutMs,
    };
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    entry.lastActivityAt = this.now();
  }

  async whileDeleting<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    this.deleting.add(sessionId);
    try {
      return await work();
    } finally {
      this.deleting.delete(sessionId);
    }
  }

  snapshot(): LiveSession[] {
    const now = this.now();
    const items: LiveSession[] = [];
    for (const [sessionId, entry] of this.entries) {
      const activity = readActivity(sessionId, this.deps.core.accessor);
      if (activity === undefined) continue;
      items.push({
        session_id: sessionId,
        workspace_id: entry.workspaceId,
        cwd: entry.cwd,
        busy: activity.busy,
        main_turn_active: activity.mainTurnActive,
        pending_interaction: activity.pendingInteraction,
        subscriber_count: this.deps.subscriberCount(sessionId),
        resumed_at: new Date(entry.resumedAt).toISOString(),
        last_activity_at: new Date(entry.lastActivityAt).toISOString(),
        idle_ms: Math.max(0, now - entry.lastActivityAt),
      });
    }
    return items.toSorted((a, b) => a.idle_ms - b.idle_ms);
  }

  async ensureCapacity(): Promise<CapacityReservation> {
    if (!this.enabled()) return { available: true, release: () => undefined };
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.reserved -= 1;
    };
    const available = await this.serializeQuota(async () => {
      this.reserved += 1;
      return this.enforceQuota();
    });
    return { available, release };
  }

  sweep(): Promise<void> {
    if (this.sweeping !== undefined) return this.sweeping;
    this.sweeping = this.runSweep().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async runSweep(): Promise<void> {
    if (this.disposed || !this.enabled()) return;
    const timeout = this.limits.sessionIdleTimeoutMs;
    if (timeout > 0) {
      const now = this.now();
      for (const [sessionId, entry] of this.entries) {
        if (now - entry.lastActivityAt < timeout) continue;
        await this.closeIfIdle(sessionId, 'idle_timeout');
      }
    }
    await this.serializeQuota(() => this.enforceQuota());
  }

  private serializeQuota<T>(work: () => Promise<T>): Promise<T> {
    const run = this.quotaQueue.then(work, work);
    this.quotaQueue = run.catch(() => undefined);
    return run;
  }

  private async enforceQuota(): Promise<boolean> {
    if (this.disposed) return true;
    const max = this.limits.maxLiveSessions;
    if (max === 0) return true;
    let excess = this.entries.size + this.reserved - max;
    if (excess <= 0) {
      this.lastWarnedExcess = 0;
      return true;
    }
    for (const sessionId of this.candidates()) {
      if (excess <= 0) break;
      if (await this.closeIfIdle(sessionId, 'quota')) excess -= 1;
    }
    if (excess > 0 && excess !== this.lastWarnedExcess) {
      this.deps.logger?.warn(
        { excess, max_live_sessions: max },
        'live session quota exceeded; every remaining session is busy, subscribed or recently active',
      );
    }
    this.lastWarnedExcess = Math.max(0, excess);
    return excess <= 0;
  }

  private candidates(): string[] {
    const cutoff = this.now() - this.evictionGraceMs;
    return [...this.entries]
      .filter(([, entry]) => entry.lastActivityAt <= cutoff)
      .toSorted(([, a], [, b]) => a.lastActivityAt - b.lastActivityAt)
      .map(([sessionId]) => sessionId);
  }

  private async closeIfIdle(sessionId: string, reason: SessionClosedReason): Promise<boolean> {
    if (this.disposed || this.closing.has(sessionId)) return false;
    if (this.deps.subscriberCount(sessionId) > 0) return false;
    const handle = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (handle === undefined || !(await isIdle(handle))) return false;
    if (this.deps.subscriberCount(sessionId) > 0) return false;
    this.closing.set(sessionId, reason);
    try {
      await closeSessionById(this.deps.core.accessor, sessionId);
      return true;
    } catch (error) {
      this.deps.logger?.warn(
        { session_id: sessionId, reason, err: error instanceof Error ? error.message : String(error) },
        'closing idle session failed',
      );
      return false;
    } finally {
      this.closing.delete(sessionId);
    }
  }

  private track(handle: ISessionScopeHandle): void {
    if (this.disposed) return;
    const context = handle.accessor.get(ISessionContext);
    const sessionId = context.sessionId;
    const existing = this.entries.get(sessionId);
    if (existing !== undefined) existing.activitySubscription.dispose();
    const now = this.now();
    this.entries.set(sessionId, {
      workspaceId: context.workspaceId,
      cwd: context.cwd,
      resumedAt: now,
      lastActivityAt: now,
      activitySubscription: handle.accessor.get(ISessionActivityView).onDidChange(() => {
        this.touch(sessionId);
      }),
    });
  }

  private untrack(sessionId: string, announce: boolean): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    this.entries.delete(sessionId);
    entry.activitySubscription.dispose();
    const reason = this.closing.get(sessionId) ?? 'exit';
    if (announce && !this.deleting.has(sessionId) && this.enabled()) {
      this.deps.announceClosed(sessionId, entry.workspaceId, reason);
    }
  }
}

function readActivity(
  sessionId: string,
  accessor: Scope['accessor'],
): ReturnType<ISessionActivityView['state']> | undefined {
  const handle = getLiveSessionById(accessor, sessionId);
  if (handle === undefined) return undefined;
  try {
    return handle.accessor.get(ISessionActivityView).state();
  } catch {
    return undefined;
  }
}

async function isIdle(handle: ISessionScopeHandle): Promise<boolean> {
  try {
    const activity = handle.accessor.get(ISessionActivityView).state();
    if (activity.busy || activity.pendingInteraction !== 'none') return false;
    const agents = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      const agentHandle = agents.handleOf(agent.agentId);
      if (agentHandle === undefined) continue;
      const loop = agentHandle.accessor.get(IAgentLoopService).snapshot();
      if (loop.state !== 'idle' || loop.queue.length > 0 || loop.hasPendingRequests) return false;
    }
    const terminals = await handle.accessor.get(ISessionTerminalService).list();
    return terminals.every((terminal) => terminal.status !== 'running');
  } catch {
    return false;
  }
}
