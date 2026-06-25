import type { ContentPart } from '@moonshot-ai/kosong';

import type { CronJobOrigin, CronMissedOrigin } from '../../../agent/context';
import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  toDisposable,
} from "#/_base/di";
import {
  resolveClockSources,
  SYSTEM_CLOCKS,
  type ClockSources,
} from '../../../tools/cron/clock';
import { CronCreateTool } from '../../../tools/cron/cron-create';
import { CronDeleteTool } from '../../../tools/cron/cron-delete';
import { renderCronFireXml } from '../../../tools/cron/cron-fire-xml';
import { CronListTool } from '../../../tools/cron/cron-list';
import {
  CRON_DELETED,
  CRON_FIRED,
  CRON_MISSED,
  CRON_SCHEDULED,
} from '../../../tools/cron/telemetry-events';
import { createCronPersistStore } from '../../../tools/cron/persist';
import { SessionCronStore } from '../../../tools/cron/session-store';
import {
  createCronScheduler,
  type CronScheduler,
} from '../../../tools/cron/scheduler';
import type { CronTask, CronToolManager } from '../../../tools/cron/types';
import { IEventBus } from '../eventBus/eventBus';
import { IPromptService } from '../prompt/prompt';
import { ITelemetryService } from '../telemetry/telemetry';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage, Turn } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  ICronService,
  type CronFireOptions,
  type CronLoadOptions,
  type CronOptions,
  type CronPersistence,
  type CronTaskInit,
} from './cron';

declare module '../types' {
  interface WireRecordMap {
    'cron.add': {
      task: CronTask;
    };
    'cron.delete': {
      ids: readonly string[];
    };
    'cron.cursor': {
      id: string;
      lastFiredAt: number;
    };
  }
}

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export class CronService
  extends Disposable
  implements ICronService, CronToolManager
{
  declare readonly _serviceBrand: undefined;

  readonly store = new SessionCronStore();
  readonly clocks: ClockSources;

  private readonly enabled: boolean;
  private readonly scheduler: CronScheduler | undefined;
  private readonly persistStore: CronPersistence | undefined;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private started = false;
  private sigusr1Handler: NodeJS.SignalsListener | null = null;

  constructor(
    private readonly options: CronOptions = {},
    @IPromptService private readonly prompt: IPromptService,
    @IEventBus private readonly events: IEventBus,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @ITurnRunner private readonly turnRunner: ITurnRunner,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IToolRegistry toolRegistry: IToolRegistry,
  ) {
    super();
    this.enabled = options.isSubagent !== true;
    this.clocks =
      options.clocks ??
      resolveClockSources(process.env['KIMI_CRON_CLOCK']) ??
      SYSTEM_CLOCKS;
    this.persistStore =
      this.enabled
        ? options.persistence ??
          (options.homedir === undefined
            ? undefined
            : createCronPersistStore(options.homedir))
        : undefined;

    this._register(
      wireRecord.register('cron.add', (record) => {
        if (this.enabled) this.store.adopt(record.task);
      }),
    );
    this._register(
      wireRecord.register('cron.delete', (record) => {
        if (this.enabled) this.store.remove(record.ids);
      }),
    );
    this._register(
      wireRecord.register('cron.cursor', (record) => {
        if (this.enabled) this.store.markFired(record.id, record.lastFiredAt);
      }),
    );
    this._register(
      wireRecord.hooks.onResumeEnded.register(
        'cron-lifecycle-resume',
        async (_ctx, next) => {
          await this.loadFromDisk({ replace: false });
          this.start();
          await next();
        },
      ),
    );

    if (this.enabled) {
      this.scheduler = createCronScheduler({
        clocks: this.clocks,
        source: () => this.store.list(),
        isIdle: () => this.turnRunner.getActiveTurn() === undefined,
        isKilled: () => process.env['KIMI_DISABLE_CRON'] === '1',
        onFire: (task, ctx) => {
          this.handleFire(task, ctx);
        },
        removeOneShot: (id) => {
          this.removeTasks([id]);
        },
        onAdvanceCursor: (id, lastFiredAt) => {
          this.advanceCursor(id, lastFiredAt);
        },
        pollIntervalMs:
          process.env['KIMI_CRON_MANUAL_TICK'] === '1'
            ? null
            : options.pollIntervalMs,
      });

      if (options.registerTools !== false) {
        this._register(toolRegistry.register(new CronCreateTool(this)));
        this._register(toolRegistry.register(new CronListTool(this)));
        this._register(toolRegistry.register(new CronDeleteTool(this)));
      }

      if (options.autoStart !== false) {
        this.start();
      }
    }

    this._register(
      toDisposable(() => {
        void this.stop();
      }),
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  addTask(init: CronTaskInit): CronTask {
    const task = this.store.add(init, this.clocks.wallNow());
    this.wireRecord.append({ type: 'cron.add', task });
    this.persistEnqueue(task.id, () => this.persistStore!.write(task.id, task));
    return task;
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    const removed = this.store.remove(ids);
    if (removed.length === 0) return removed;

    this.wireRecord.append({ type: 'cron.delete', ids: removed });
    for (const id of removed) {
      this.persistEnqueue(id, () => this.persistStore!.remove(id));
    }
    return removed;
  }

  private removeTasksSilent(ids: readonly string[]): readonly string[] {
    const removed = this.store.remove(ids);
    if (removed.length === 0) return removed;

    for (const id of removed) {
      this.persistEnqueue(id, () => this.persistStore!.remove(id));
    }
    return removed;
  }

  getTask(id: string): CronTask | undefined {
    return this.store.get(id);
  }

  list(): readonly CronTask[] {
    return this.store.list();
  }

  async loadFromDisk(options: CronLoadOptions = {}): Promise<void> {
    if (!this.enabled || this.persistStore === undefined) return;
    const tasks = await this.persistStore.list();
    if (options.replace !== false) {
      this.store.clear();
    }
    for (const task of tasks) {
      this.store.adopt(task);
    }
  }

  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.scheduler?.start();
    this.bindSigusr1();
  }

  async stop(): Promise<void> {
    this.unbindSigusr1();
    await this.scheduler?.stop();
    await this.flushPersist();
    this.started = false;
  }

  tick(): void {
    this.scheduler?.tick();
  }

  getNextFireTime(): number | null {
    return this.scheduler?.getNextFireTime() ?? null;
  }

  getNextFireForTask(taskId: string): number | null {
    return this.scheduler?.getNextFireForTask(taskId) ?? null;
  }

  fire(id: string, options: CronFireOptions = {}): Turn | undefined {
    if (!this.enabled) return undefined;
    const task = this.store.get(id);
    if (task === undefined) return undefined;

    const firedAt = options.firedAt ?? this.clocks.wallNow();
    const stale = this.isStaleAt(task, firedAt);
    const turn = this.deliverFire(task, {
      coalescedCount: options.coalescedCount ?? 1,
      firedAt,
    });
    if (task.recurring === false) {
      this.removeTasksSilent([task.id]);
    } else if (stale) {
      const removed = this.removeTasks([task.id]);
      if (removed.length > 0) {
        this.emitDeleted(task.id);
      }
    } else {
      this.advanceCursor(task.id, firedAt);
    }
    return turn;
  }

  isStale(task: CronTask): boolean {
    return this.isStaleAt(task, this.clocks.wallNow());
  }

  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (
      tasks: readonly CronTask[],
    ) => readonly ContentPart[],
  ): Turn | undefined {
    if (!this.enabled || tasks.length === 0) return undefined;
    const origin: CronMissedOrigin = {
      kind: 'cron_missed',
      count: tasks.length,
    };
    const message: ContextMessage = {
      role: 'user',
      content: [...renderMissedNotification(tasks)],
      toolCalls: [],
      origin,
    };
    const turn = this.prompt.steer(message);
    this.telemetry.track(CRON_MISSED, { count: tasks.length });
    return turn;
  }

  emitScheduled(task: CronTask): void {
    this.telemetry.track(CRON_SCHEDULED, {
      recurring: task.recurring !== false,
    });
  }

  emitDeleted(taskId: string): void {
    this.telemetry.track(CRON_DELETED, { task_id: taskId });
  }

  async flushPersist(): Promise<void> {
    const inFlight = Array.from(this.persistQueues.values());
    await Promise.allSettled(inFlight);
  }

  private handleFire(
    task: CronTask,
    ctx: { readonly coalescedCount: number },
  ): void {
    const firedAt = this.clocks.wallNow();
    const stale = this.isStaleAt(task, firedAt);
    this.deliverFire(task, {
      coalescedCount: ctx.coalescedCount,
      firedAt,
    });
    if (stale && task.recurring !== false) {
      const removed = this.removeTasks([task.id]);
      if (removed.length > 0) this.emitDeleted(task.id);
    }
  }

  private deliverFire(
    task: CronTask,
    ctx: { readonly coalescedCount: number; readonly firedAt: number },
  ): Turn | undefined {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      coalescedCount: ctx.coalescedCount,
      stale: this.isStaleAt(task, ctx.firedAt),
    };
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: renderCronFireXml(origin, task.prompt),
        },
      ],
      toolCalls: [],
      origin,
    };
    this.events.emit({ type: 'cron.fired', origin, prompt: task.prompt });
    const turn = this.prompt.steer(message);
    this.telemetry.track(CRON_FIRED, {
      recurring: task.recurring !== false,
      coalesced_count: ctx.coalescedCount,
      stale: origin.stale,
      buffered: turn === undefined,
    });
    return turn;
  }

  private advanceCursor(id: string, lastFiredAt: number): void {
    const updated = this.store.markFired(id, lastFiredAt);
    if (updated === undefined) return;

    this.wireRecord.append({ type: 'cron.cursor', id, lastFiredAt });
    this.persistEnqueue(id, () => this.persistStore!.write(id, updated));
  }

  private isStaleAt(task: CronTask, now: number): boolean {
    if (process.env['KIMI_CRON_NO_STALE'] === '1') return false;
    if (task.recurring === false) return false;
    const age = now - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }

  private persistEnqueue(id: string, work: () => Promise<void>): void {
    if (this.persistStore === undefined) return;
    const prev = this.persistQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => work())
      .catch((error: unknown) => {
        this.options.onPersistenceError?.(error, id);
      })
      .finally(() => {
        if (this.persistQueues.get(id) === next) {
          this.persistQueues.delete(id);
        }
      });
    this.persistQueues.set(id, next);
  }

  private bindSigusr1(): void {
    if (process.platform === 'win32') return;
    if (process.env['KIMI_CRON_MANUAL_TICK'] !== '1') return;
    if (this.sigusr1Handler !== null) return;
    const handler: NodeJS.SignalsListener = () => {
      try {
        this.tick();
      } catch (error) {
        if (process.env['KIMI_CRON_DEBUG'] === '1') {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[cron/service] SIGUSR1 tick threw: ${msg}\n`);
        }
      }
    };
    this.sigusr1Handler = handler;
    process.on('SIGUSR1', handler);
  }

  private unbindSigusr1(): void {
    if (this.sigusr1Handler === null) return;
    process.off('SIGUSR1', this.sigusr1Handler);
    this.sigusr1Handler = null;
  }
}

registerSingleton(ICronService, new SyncDescriptor(CronService, [{}], true));
