import { Disposable } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentSuspended } from '#/features/swarm/session/sessionSwarmService';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ILogService } from '#/_base/log/log';

import { SubagentCancelled, SubagentCompleted, SubagentFailed, SubagentStarted } from './mirrorAgentRun';
import {
  ISessionSubagentScopeCacheService,
  resolveSubagentScopeCacheSize,
  resolveSubagentScopeEvictTimeoutMs,
} from './subagentScopeCache';

const MAX_EVICT_ATTEMPTS = 3;

type EvictOutcome = 'removed' | 'missing' | 'closing' | 'deferred' | 'timeout' | 'failed';

export class SessionSubagentScopeCacheService
  extends Disposable
  implements ISessionSubagentScopeCacheService
{
  declare readonly _serviceBrand: undefined;

  private readonly capacity: number;
  private readonly removeTimeoutMs: number;
  private readonly retired = new Map<string, number>();
  private readonly closing = new Set<string>();
  private evictions: Promise<void> = Promise.resolve();

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionEventBus bus: ISessionEventBus,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.capacity = resolveSubagentScopeCacheSize();
    this.removeTimeoutMs = resolveSubagentScopeEvictTimeoutMs();
    if (this.capacity === 0) return;
    this._register(
      bus.subscribe(SubagentCompleted, (event) => {
        this.retire(event.subagentId);
      }),
    );
    this._register(
      bus.subscribe(SubagentFailed, (event) => {
        this.retire(event.subagentId);
      }),
    );
    this._register(
      bus.subscribe(SubagentCancelled, (event) => {
        this.retire(event.subagentId);
      }),
    );
    this._register(
      bus.subscribe(SubagentStarted, (event) => {
        this.revive(event.subagentId);
      }),
    );
    this._register(
      bus.subscribe(SubagentSuspended, (event) => {
        this.revive(event.subagentId);
      }),
    );
    this._register(
      this.agentLifecycle.onDidCreate((agent) => {
        this.revive(agent.agentId);
      }),
    );
    this._register(
      this.agentLifecycle.onWillClose((agent) => {
        this.closing.add(agent.agentId);
      }),
    );
    this._register(
      this.agentLifecycle.onDidClose((agent) => {
        this.closing.delete(agent.agentId);
        this.revive(agent.agentId);
      }),
    );
  }

  private retire(agentId: string): void {
    this.retired.delete(agentId);
    this.retired.set(agentId, 0);
    this.evictions = this.evictions.then(() => this.evictOverflow()).catch(onUnexpectedError);
  }

  private revive(agentId: string): void {
    this.retired.delete(agentId);
  }

  private async evictOverflow(): Promise<void> {
    if (this.retired.size <= this.capacity) return;
    const candidates = [...this.retired.entries()].filter(
      ([, attempts]) => attempts < MAX_EVICT_ATTEMPTS,
    );
    for (const [agentId, attempts] of candidates) {
      if (this.retired.size <= this.capacity) return;
      if (this.retired.get(agentId) !== attempts) continue;
      this.retired.delete(agentId);
      const outcome = await this.evict(agentId);
      if (outcome === 'removed' || outcome === 'missing') continue;
      if (outcome === 'deferred') {
        this.log.debug('subagent scope eviction deferred; agent still busy', { agentId });
        if (!this.retired.has(agentId)) this.retired.set(agentId, attempts);
        continue;
      }
      if (outcome === 'closing' || outcome === 'failed') {
        if (!this.retired.has(agentId)) this.retired.set(agentId, attempts);
        continue;
      }
      const nextAttempt = attempts + 1;
      if (nextAttempt >= MAX_EVICT_ATTEMPTS) {
        this.log.warn('subagent scope eviction abandoned; agent still busy', {
          agentId,
          attempts: nextAttempt,
        });
      }
      if (!this.retired.has(agentId)) this.retired.set(agentId, nextAttempt);
    }
  }

  private async evict(agentId: string): Promise<EvictOutcome> {
    const context = this.agentLifecycle.get(agentId);
    if (context === undefined) return this.closing.has(agentId) ? 'closing' : 'missing';
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) return this.closing.has(agentId) ? 'closing' : 'missing';
    const snapshot = handle.accessor.get(IAgentLoopService).snapshot();
    if (snapshot.state === 'running' || snapshot.hasPendingRequests) return 'deferred';
    if (handle.accessor.get(IAgentTaskService).list(true).length > 0) return 'deferred';
    const startedAt = Date.now();
    const removal = this.agentLifecycle.remove(context).then(
      () => 'removed' as const,
      (error: unknown) => ({ error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      removal,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.removeTimeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    if (outcome === 'timeout') {
      this.log.warn('subagent scope eviction timed out; moving on to the next eviction', {
        agentId,
        durationMs,
      });
      return 'timeout';
    }
    if (outcome === 'removed') {
      this.log.debug('subagent scope evicted', { agentId, durationMs });
      return 'removed';
    }
    const gone = this.agentLifecycle.get(agentId) === undefined && !this.closing.has(agentId);
    this.log.warn('subagent scope eviction failed', {
      agentId,
      durationMs,
      error: outcome.error,
    });
    return gone ? 'removed' : 'failed';
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentScopeCacheService,
  SessionSubagentScopeCacheService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
