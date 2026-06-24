/**
 * `cron` domain (L5) — `ICronService` + `ICronFireCoordinator` implementation.
 *
 * `CronService` owns the session's cron tasks and a minimal scheduler: each
 * task carries a `nextFireAt`; `tick(now)` fires due tasks (gated on
 * `ISessionActivity.isIdle()`), emitting `onDidFire`. One-shot tasks are
 * removed after firing; recurring tasks advance `nextFireAt`. The cron
 * expression parser is intentionally minimal (numeric ms interval or a
 * default) — full cron-syntax support is a later step.
 *
 * `CronFireCoordinator` subscribes `onDidFire` and steers the `main` agent
 * via `IAgentLifecycleService`.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IEnvironmentService } from '#/environment/environment';
import { ILogService } from '#/log/log';
import { ISessionMetaStore } from '#/records/records';
import { ISessionActivity } from '#/session-activity/sessionActivity';
import { ISessionContext } from '#/session-context/sessionContext';
import { ITelemetryService } from '#/telemetry/telemetry';
import { ITurnService } from '#/turn/turn';

import {
  type CronFiredEvent,
  type CronTask,
  ICronFireCoordinator,
  ICronService,
} from './cron';

const DEFAULT_INTERVAL_MS = 60_000;

function parseIntervalMs(cron: string): number {
  const n = Number(cron);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

interface ScheduledTask {
  readonly task: CronTask;
  nextFireAt: number;
}

let nextCronId = 0;

export class CronService extends Disposable implements ICronService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidFire = this._register(new Emitter<CronFiredEvent>());
  readonly onDidFire: Event<CronFiredEvent> = this._onDidFire.event;
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(
    @ISessionContext _ctx: ISessionContext,
    @ISessionActivity private readonly activity: ISessionActivity,
    @ITelemetryService _telemetry: ITelemetryService,
    @ILogService _log: ILogService,
    @IEnvironmentService _env: IEnvironmentService,
    @ISessionMetaStore _meta: ISessionMetaStore,
  ) {
    super();
  }

  create(task: CronTask): Promise<string> {
    const id = task.id || `cron-${nextCronId++}`;
    const stored: CronTask = { ...task, id };
    this.tasks.set(id, {
      task: stored,
      nextFireAt: Date.now() + parseIntervalMs(task.cron),
    });
    return Promise.resolve(id);
  }

  list(): readonly CronTask[] {
    return [...this.tasks.values()].map((s) => s.task);
  }

  delete(id: string): Promise<void> {
    this.tasks.delete(id);
    return Promise.resolve();
  }

  /** Fire all due tasks (idle-gated). Exposed for deterministic testing. */
  tick(now: number = Date.now()): void {
    if (!this.activity.isIdle()) return;
    for (const scheduled of this.tasks.values()) {
      if (scheduled.nextFireAt > now) continue;
      this._onDidFire.fire({
        taskId: scheduled.task.id,
        content: scheduled.task.prompt,
      });
      if (scheduled.task.recurring === false) {
        this.tasks.delete(scheduled.task.id);
      } else {
        scheduled.nextFireAt = now + parseIntervalMs(scheduled.task.cron);
      }
    }
  }
}

export class CronFireCoordinator extends Disposable implements ICronFireCoordinator {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ICronService cron: ICronService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
  ) {
    super();
    this._register(cron.onDidFire((e) => this.onFire(e)));
  }

  private onFire(e: CronFiredEvent): void {
    const main = this.agents.getHandle('main');
    if (main === undefined) return;
    main.accessor.get(ITurnService).steer(e.content, e.origin);
  }
}

registerScopedService(LifecycleScope.Session, ICronService, CronService, InstantiationType.Delayed, 'cron');
registerScopedService(LifecycleScope.Session, ICronFireCoordinator, CronFireCoordinator, InstantiationType.Delayed, 'cron');
