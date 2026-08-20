import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';

import picomatch from 'picomatch';
import { basename, dirname, join, resolve } from 'pathe';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { setClampedTimeout } from '#/_base/utils/timer';
import { IEventBus } from '#/app/event/eventBus';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import type { ContextMessage, MonitorOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTaskService, type AgentTaskInfo, type AgentTaskOutputChunk } from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { renderNotificationXml } from '#/agent/task/notificationXml';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import type { IHostProcess } from '#/os/interface/hostProcess';
import type { RuntimeLease } from '#/runtime/runtime';
import {
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';
import {
  IAgentMonitorService,
  MONITOR_MAX_ACTIVE,
  MonitorNotified,
  isMonitorOrigin,
  monitorDeliveredNotificationKeysKey,
  monitorNotificationDeliveryKey,
  monitorNotificationKey,
  monitorScheduledNotificationKeysKey,
  type CommandMonitorSpec,
  type FileMonitorSpec,
  type MonitorFileEvent,
  type MonitorFiredNotification,
  type MonitorInfo,
  type MonitorNotification,
  type MonitorSpec,
  type MonitorStatus,
  type MonitorTrigger,
  type MonitorType,
  type TaskOutputMonitorSpec,
} from './monitor';
import { MonitorError, MonitorErrors } from './errors';

const MONITOR_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const LINE_REMAINDER_CAP_CHARS = 4 * 1024;
const MATCHED_LINE_MAX_CHARS = 500;
const MONITOR_DOC_SUFFIX = '.json';
const GLOB_MAGIC = /[*?{}[\]]/;

interface MonitorRecord {
  monitorId: string;
  type: MonitorType;
  status: MonitorStatus;
  description?: string;
  timeoutMs: number;
  createdAt: number;
  endedAt: number | null;
  trigger?: MonitorTrigger;
  notificationId?: string;
  taskId?: string;
  pattern?: string;
  command?: string;
  path?: string;
  events?: readonly MonitorFileEvent[];
  fired?: MonitorFiredNotification;
}

interface ManagedMonitor {
  readonly record: MonitorRecord;
  regex?: RegExp;
  lineRemainder: string;
  watchedTaskId?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  watchHandle?: IHostFsWatchHandle;
  watchSubscription?: IDisposable;
  matchesFile?: (changedPath: string) => boolean;
}

interface MonitorFireDetail {
  readonly matchedLine?: string;
  readonly exitCode?: number | null;
  readonly changedPath?: string;
}

export class MonitorNotificationStepRequest extends MessageStepRequest {
  constructor(
    message: ContextMessage,
    private readonly onWillDeliver?: () => void,
  ) {
    super(message, {
      kind: 'monitor_notification',
      mergeable: true,
      turnScoped: false,
      admission: 'activeOrNewTurn',
    });
  }

  override onWillMaterialize(): void {
    this.onWillDeliver?.();
  }
}

export class AgentMonitorService extends Disposable implements IAgentMonitorService {
  declare readonly _serviceBrand: undefined;

  private readonly monitors = new Map<string, ManagedMonitor>();
  private readonly outputWatchers = new Map<string, Set<ManagedMonitor>>();
  private readonly terminalWatchers = new Map<string, Set<ManagedMonitor>>();
  private readonly pendingNotificationRequests = new Map<string, MonitorNotificationStepRequest>();
  private restoreQueue: Promise<void> = Promise.resolve();

  constructor(
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAtomicDocumentStore private readonly atomicDocs: IAtomicDocumentStore,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentConversationUndoParticipantRegistry
    undoParticipants: IAgentConversationUndoParticipantRegistry,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.states.contributeState(monitorNotificationDeliveryKey);
    this.states.contributeState(monitorScheduledNotificationKeysKey);
    this.states.contributeState(monitorDeliveredNotificationKeysKey);
    this._register(
      this.tasks.onDidAppendOutput((chunk) => {
        this.forwardOutput(chunk);
      }),
    );
    this._register(
      this.eventBus.subscribe(TaskTerminatedNotice, (e) => {
        this.onTaskTerminated(e.info);
      }),
    );
    this._register(
      undoParticipants.register({
        id: 'monitor.notificationDelivery',
        reconcileAfterUndo: () => this.reconcileNotificationDeliveryAfterUndo(),
      }),
    );
    this._register(
      this.dispatcher.hooks.onDidRestore.register('monitor', async (_ctx, next) => {
        for (const key of this.states.get(monitorNotificationDeliveryKey)) {
          this.deliveredNotificationKeys.add(key);
        }
        await this.restoreAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(ContextSpliced, (e) => {
        for (const message of e.messages) {
          if (isMonitorOrigin(message.origin)) {
            this.markDeliveredNotification(message.origin);
          }
        }
      }),
    );
    void this.restoreAfterReplay();
  }

  private get scheduledNotificationKeys(): Set<string> {
    return this.states.get(monitorScheduledNotificationKeysKey);
  }

  private get deliveredNotificationKeys(): Set<string> {
    return this.states.get(monitorDeliveredNotificationKeysKey);
  }

  async createMonitor(spec: MonitorSpec): Promise<MonitorInfo> {
    if (this.activeCount() >= MONITOR_MAX_ACTIVE) {
      throw new MonitorError(
        MonitorErrors.codes.MONITOR_LIMIT_EXCEEDED,
        `Too many active monitors (max ${String(MONITOR_MAX_ACTIVE)}). Cancel one before creating another.`,
      );
    }
    const record: MonitorRecord = {
      monitorId: generateMonitorId(),
      type: spec.type,
      status: 'active',
      description: spec.description,
      timeoutMs: spec.timeoutMs,
      createdAt: Date.now(),
      endedAt: null,
    };
    const managed: ManagedMonitor = { record, lineRemainder: '' };
    switch (spec.type) {
      case 'task_output':
        this.setupTaskOutputMonitor(managed, spec);
        break;
      case 'command':
        await this.setupCommandMonitor(managed, spec);
        break;
      case 'file':
        await this.setupFileMonitor(managed, spec);
        break;
    }
    this.monitors.set(record.monitorId, managed);
    if (record.status === 'active') {
      this.armTimeout(managed);
    }
    await this.persistRecord(record);
    this.telemetry.track2('monitor_created', {
      monitor_type: record.type,
      has_pattern: record.pattern !== undefined,
      timeout_ms: record.timeoutMs,
    });
    return this.toInfo(record);
  }

  listMonitors(): readonly MonitorInfo[] {
    return [...this.monitors.values()]
      .map((managed) => this.toInfo(managed.record))
      .toSorted((a, b) => a.createdAt - b.createdAt);
  }

  async cancelMonitor(monitorId: string): Promise<MonitorInfo | undefined> {
    const managed = this.monitors.get(monitorId);
    if (managed === undefined) return undefined;
    const record = managed.record;
    if (record.status !== 'active') return this.toInfo(record);
    record.status = 'cancelled';
    record.endedAt = Date.now();
    this.cleanupMonitor(managed);
    if (record.type === 'command' && record.taskId !== undefined) {
      void this.tasks.stop(record.taskId, `Monitor ${monitorId} cancelled`).catch(() => {});
    }
    await this.persistRecord(record);
    this.telemetry.track2('monitor_cancelled', {
      monitor_type: record.type,
      duration_ms: record.endedAt - record.createdAt,
    });
    return this.toInfo(record);
  }

  override dispose(): void {
    for (const managed of this.monitors.values()) {
      this.cleanupMonitor(managed);
    }
    super.dispose();
  }

  private activeCount(): number {
    let count = 0;
    for (const managed of this.monitors.values()) {
      if (managed.record.status === 'active') count++;
    }
    return count;
  }

  private setupTaskOutputMonitor(managed: ManagedMonitor, spec: TaskOutputMonitorSpec): void {
    const record = managed.record;
    managed.regex = this.compilePattern(spec.pattern);
    record.pattern = spec.pattern;
    record.taskId = spec.taskId;
    const target = this.tasks.getTask(spec.taskId);
    if (target === undefined) {
      throw new MonitorError(
        MonitorErrors.codes.MONITOR_NOT_FOUND,
        `Task not found: ${spec.taskId}`,
      );
    }
    if (TERMINAL_STATUSES.has(target.status)) {
      record.status = 'ended';
      record.endedAt = Date.now();
      return;
    }
    this.addWatcher(this.outputWatchers, spec.taskId, managed);
    this.addWatcher(this.terminalWatchers, spec.taskId, managed);
    void this.tasks.readOutput(spec.taskId).then(
      (backlog) => {
        this.feedChunk(managed, backlog);
      },
      () => {},
    );
  }

  private async setupCommandMonitor(managed: ManagedMonitor, spec: CommandMonitorSpec): Promise<void> {
    const record = managed.record;
    if (spec.pattern !== undefined) {
      managed.regex = this.compilePattern(spec.pattern);
      record.pattern = spec.pattern;
    }
    record.command = spec.command;
    const lease = this.runtime.acquire(['process']);
    if (lease.runtime.process === undefined) {
      lease.dispose();
      throw new MonitorError(
        MonitorErrors.codes.MONITOR_RUNTIME_UNAVAILABLE,
        'The active runtime cannot spawn processes.',
      );
    }
    let proc: IHostProcess;
    try {
      proc = lease.track(await this.spawnMonitorCommand(lease, spec.command));
    } catch (error) {
      lease.dispose();
      throw error;
    }
    const description =
      spec.description !== undefined && spec.description.length > 0
        ? spec.description
        : `Monitor: ${spec.command}`;
    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new ProcessTask(proc, spec.command, description, undefined, () => {
          lease.dispose();
        }),
        { terminalNotificationSuppressed: true },
      );
    } catch (error) {
      try {
        await proc.kill('SIGTERM');
      } catch {
      } finally {
        await disposeQuietly(proc);
        lease.dispose();
      }
      throw error;
    }
    record.taskId = taskId;
    if (managed.regex !== undefined) {
      this.addWatcher(this.outputWatchers, taskId, managed);
    }
    this.addWatcher(this.terminalWatchers, taskId, managed);
  }

  private async setupFileMonitor(managed: ManagedMonitor, spec: FileMonitorSpec): Promise<void> {
    const record = managed.record;
    const absolute = canonicalizeForWatch(resolve(this.session.cwd, spec.path));
    record.path = spec.path;
    record.events = spec.events ?? ['created', 'modified'];
    const actions = new Set<MonitorFileEvent>(record.events);
    const isGlob = GLOB_MAGIC.test(spec.path);
    const matcher = isGlob ? picomatch(normalizeSlashes(absolute)) : undefined;
    managed.matchesFile = (changedPath: string): boolean => {
      const normalized = normalizeSlashes(changedPath);
      if (matcher !== undefined) return matcher(normalized);
      const target = normalizeSlashes(absolute);
      return normalized === target || normalized.startsWith(`${target}/`);
    };
    const watchRoot = isGlob ? staticWatchRoot(absolute) : absolute;
    const handle = this.fsWatch.watch(watchRoot, { recursive: true });
    managed.watchHandle = handle;
    managed.watchSubscription = handle.onDidChange((change) => {
      if (change.action !== 'created' && change.action !== 'modified') return;
      if (!actions.has(change.action)) return;
      if (managed.matchesFile?.(change.path) !== true) return;
      this.fireMonitor(managed, 'match', { changedPath: change.path });
    });
    try {
      await handle.ready;
    } catch (error) {
      managed.watchSubscription?.dispose();
      managed.watchSubscription = undefined;
      managed.watchHandle = undefined;
      handle.dispose();
      throw new MonitorError(
        MonitorErrors.codes.MONITOR_WATCH_FAILED,
        `Failed to watch ${watchRoot}: ${errorMessage(error)}`,
      );
    }
  }

  private spawnMonitorCommand(lease: RuntimeLease, command: string): Promise<IHostProcess> {
    const processService = lease.runtime.process;
    if (processService === undefined) {
      throw new MonitorError(
        MonitorErrors.codes.MONITOR_RUNTIME_UNAVAILABLE,
        'The active runtime cannot spawn processes.',
      );
    }
    const env = lease.runtime.environment;
    const cwd = env.osKind === 'Windows' ? windowsPathToPosixPath(this.session.cwd) : this.session.cwd;
    const shellCommand = `cd ${shellQuote(cwd)} && ${command}`;
    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: env.shellPath,
    };
    return processService.spawn(env.shellPath, ['-c', shellCommand], { env: noninteractiveEnv });
  }

  private compilePattern(pattern: string): RegExp {
    try {
      return new RegExp(pattern);
    } catch (error) {
      throw new MonitorError(
        MonitorErrors.codes.MONITOR_INVALID_PATTERN,
        `Invalid regular expression: ${errorMessage(error)}`,
      );
    }
  }

  private addWatcher(
    registry: Map<string, Set<ManagedMonitor>>,
    taskId: string,
    managed: ManagedMonitor,
  ): void {
    let set = registry.get(taskId);
    if (set === undefined) {
      set = new Set();
      registry.set(taskId, set);
    }
    set.add(managed);
    managed.watchedTaskId = taskId;
  }

  private removeWatcher(
    registry: Map<string, Set<ManagedMonitor>>,
    managed: ManagedMonitor,
  ): void {
    const taskId = managed.watchedTaskId;
    if (taskId === undefined) return;
    const set = registry.get(taskId);
    if (set !== undefined) {
      set.delete(managed);
      if (set.size === 0) registry.delete(taskId);
    }
  }

  private armTimeout(managed: ManagedMonitor): void {
    managed.timeoutHandle = setClampedTimeout(() => {
      managed.timeoutHandle = undefined;
      this.fireMonitor(managed, 'timeout', {});
    }, managed.record.timeoutMs);
    managed.timeoutHandle.unref?.();
  }

  private forwardOutput(chunk: AgentTaskOutputChunk): void {
    const watchers = this.outputWatchers.get(chunk.taskId);
    if (watchers === undefined) return;
    for (const managed of watchers) {
      this.feedChunk(managed, chunk.chunk);
    }
  }

  private feedChunk(managed: ManagedMonitor, chunk: string): void {
    const regex = managed.regex;
    if (regex === undefined || managed.record.status !== 'active') return;
    const text = managed.lineRemainder + chunk;
    const lines = text.split('\n');
    managed.lineRemainder = lines.pop() ?? '';
    if (managed.lineRemainder.length > LINE_REMAINDER_CAP_CHARS) {
      managed.lineRemainder = managed.lineRemainder.slice(-LINE_REMAINDER_CAP_CHARS);
    }
    for (const line of lines) {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        this.fireMonitor(managed, 'match', {
          matchedLine:
            line.length > MATCHED_LINE_MAX_CHARS
              ? line.slice(0, MATCHED_LINE_MAX_CHARS)
              : line,
        });
        return;
      }
    }
  }

  private onTaskTerminated(info: AgentTaskInfo): void {
    const watchers = this.terminalWatchers.get(info.taskId);
    if (watchers === undefined) return;
    for (const managed of watchers) {
      if (managed.record.status !== 'active') continue;
      if (managed.record.type === 'command') {
        this.fireMonitor(managed, 'exit', {
          exitCode: info.kind === 'process' ? info.exitCode : null,
        });
      } else if (managed.record.type === 'task_output') {
        this.endMonitor(managed);
      }
    }
  }

  private fireMonitor(
    managed: ManagedMonitor,
    trigger: MonitorTrigger,
    detail: MonitorFireDetail,
  ): void {
    const record = managed.record;
    if (record.status !== 'active') return;
    record.status = 'fired';
    record.trigger = trigger;
    record.endedAt = Date.now();
    record.notificationId = `monitor:${record.monitorId}:${trigger}`;
    this.cleanupMonitor(managed);
    const origin: MonitorOrigin = {
      kind: 'monitor',
      monitorId: record.monitorId,
      monitorType: record.type,
      trigger,
      notificationId: record.notificationId,
    };
    const notification: MonitorNotification = {
      id: record.notificationId,
      category: 'monitor',
      type: `monitor.${record.type}.${trigger}`,
      source_kind: 'monitor',
      source_id: record.monitorId,
      title: monitorNotificationTitle(record, trigger),
      severity: monitorNotificationSeverity(trigger, detail),
      body: buildMonitorNotificationBody(record, trigger, detail),
    };
    record.fired = { origin, notification };
    this.scheduledNotificationKeys.add(monitorNotificationKey(origin));
    void this.persistRecord(record);
    this.telemetry.track2('monitor_fired', {
      monitor_type: record.type,
      trigger,
      duration_ms: record.endedAt - record.createdAt,
    });
    if (record.type === 'command' && trigger !== 'exit' && record.taskId !== undefined) {
      void this.tasks
        .stop(record.taskId, `Monitor ${record.monitorId} ${trigger}`)
        .catch(() => {});
    }
    void this.notifyMonitor(record).catch((error: unknown) => {
      this.log.error('monitor notification delivery failed', {
        monitorId: record.monitorId,
        error,
      });
    });
  }

  private endMonitor(managed: ManagedMonitor): void {
    const record = managed.record;
    if (record.status !== 'active') return;
    record.status = 'ended';
    record.endedAt = Date.now();
    this.cleanupMonitor(managed);
    void this.persistRecord(record);
  }

  private cleanupMonitor(managed: ManagedMonitor): void {
    if (managed.timeoutHandle !== undefined) {
      clearTimeout(managed.timeoutHandle);
      managed.timeoutHandle = undefined;
    }
    this.removeWatcher(this.outputWatchers, managed);
    this.removeWatcher(this.terminalWatchers, managed);
    managed.watchedTaskId = undefined;
    managed.watchSubscription?.dispose();
    managed.watchSubscription = undefined;
    managed.watchHandle?.dispose();
    managed.watchHandle = undefined;
  }

  private async notifyMonitor(record: MonitorRecord): Promise<void> {
    const fired = record.fired;
    if (fired === undefined) return;
    const key = monitorNotificationKey(fired.origin);
    if (this.deliveredNotificationKeys.has(key)) return;
    const request = new MonitorNotificationStepRequest(
      {
        role: 'user',
        content: [{ type: 'text', text: renderNotificationXml(fired.notification) }],
        toolCalls: [],
        origin: fired.origin,
      },
      () => {
        this.fireNotificationHook(fired.notification);
      },
    );
    this.pendingNotificationRequests.set(key, request);
    try {
      const receipt = this.loop.enqueue(request);
      void receipt.assigned
        .then(({ step }) => step.result)
        .then(
          () => {
            if (request.aborted) this.clearPendingNotification(key, request);
          },
          () => {
            this.clearPendingNotification(key, request);
          },
        );
    } catch (error) {
      this.clearPendingNotification(key, request);
      throw error;
    }
  }

  private restoreMonitorNotification(record: MonitorRecord): void {
    const fired = record.fired;
    if (fired === undefined) return;
    const key = monitorNotificationKey(fired.origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.deliveredNotificationKeys.has(key)) return;
    if (this.hasDeliveredNotification(key)) return;
    this.context.append({
      role: 'user',
      content: [{ type: 'text', text: renderNotificationXml(fired.notification) }],
      toolCalls: [],
      origin: fired.origin,
    });
    this.fireNotificationHook(fired.notification);
  }

  private async reconcileNotificationDeliveryAfterUndo(): Promise<void> {
    const restoredKeys = new Set(this.states.get(monitorNotificationDeliveryKey));
    for (const [key, request] of this.pendingNotificationRequests) {
      if (request.aborted) this.clearPendingNotification(key, request);
    }
    this.deliveredNotificationKeys.clear();
    for (const key of restoredKeys) this.deliveredNotificationKeys.add(key);
    for (const key of this.scheduledNotificationKeys) {
      if (restoredKeys.has(key) || !this.pendingNotificationRequests.has(key)) {
        this.scheduledNotificationKeys.delete(key);
      }
    }
    for (const managed of this.monitors.values()) {
      if (managed.record.status === 'fired') {
        this.restoreMonitorNotification(managed.record);
      }
    }
  }

  private restoreAfterReplay(): Promise<void> {
    const restore = this.restoreQueue.then(() => this.restoreAfterReplayNow());
    this.restoreQueue = restore.catch(() => {});
    return restore;
  }

  private async restoreAfterReplayNow(): Promise<void> {
    const records = await this.loadPersisted();
    for (const record of records) {
      if (this.monitors.has(record.monitorId)) continue;
      if (record.status === 'active') {
        record.status = 'lost';
        record.endedAt = record.endedAt ?? Date.now();
        await this.persistRecord(record);
      }
      this.monitors.set(record.monitorId, { record, lineRemainder: '' });
      if (record.status === 'fired') {
        this.restoreMonitorNotification(record);
      }
    }
  }

  private markDeliveredNotification(origin: MonitorOrigin): void {
    const key = monitorNotificationKey(origin);
    this.scheduledNotificationKeys.delete(key);
    this.pendingNotificationRequests.delete(key);
    this.deliveredNotificationKeys.add(key);
  }

  private clearPendingNotification(key: string, request: MonitorNotificationStepRequest): void {
    if (this.pendingNotificationRequests.get(key) !== request) return;
    this.pendingNotificationRequests.delete(key);
    if (!this.deliveredNotificationKeys.has(key) && !this.hasDeliveredNotification(key)) {
      this.scheduledNotificationKeys.delete(key);
    }
  }

  private hasDeliveredNotification(key: string): boolean {
    return this.context.get().some((message) => {
      return isMonitorOrigin(message.origin) && monitorNotificationKey(message.origin) === key;
    });
  }

  private fireNotificationHook(notification: MonitorNotification): void {
    void this.dispatcher.dispatch(
      new MonitorNotified({
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      }),
    );
  }

  private persistenceScope(): string {
    return this.scopeContext.scope('monitors');
  }

  private async persistRecord(record: MonitorRecord): Promise<void> {
    try {
      await this.atomicDocs.set(
        this.persistenceScope(),
        `${record.monitorId}${MONITOR_DOC_SUFFIX}`,
        record,
      );
    } catch (error) {
      this.log.error('monitor persist failed', { monitorId: record.monitorId, error });
    }
  }

  private async loadPersisted(): Promise<MonitorRecord[]> {
    const keys = await this.atomicDocs.list(this.persistenceScope());
    const records: MonitorRecord[] = [];
    for (const key of keys) {
      if (!key.endsWith(MONITOR_DOC_SUFFIX)) continue;
      try {
        const record = await this.atomicDocs.get<MonitorRecord>(this.persistenceScope(), key);
        if (record !== undefined && typeof record.monitorId === 'string') {
          records.push(record);
        }
      } catch {
      }
    }
    return records.toSorted((a, b) => a.createdAt - b.createdAt);
  }

  private toInfo(record: MonitorRecord): MonitorInfo {
    return {
      monitorId: record.monitorId,
      type: record.type,
      status: record.status,
      description: record.description,
      timeoutMs: record.timeoutMs,
      createdAt: record.createdAt,
      endedAt: record.endedAt,
      trigger: record.trigger,
      taskId: record.taskId,
      pattern: record.pattern,
      command: record.command,
      path: record.path,
      events: record.events,
    };
  }
}

function monitorNotificationTitle(record: MonitorRecord, trigger: MonitorTrigger): string {
  switch (trigger) {
    case 'match':
      return `Monitor matched (${record.type})`;
    case 'exit':
      return 'Monitored command exited';
    case 'timeout':
      return 'Monitor timed out';
  }
}

function monitorNotificationSeverity(
  trigger: MonitorTrigger,
  detail: MonitorFireDetail,
): 'info' | 'warning' {
  if (trigger === 'match') return 'info';
  if (trigger === 'exit') return detail.exitCode === 0 ? 'info' : 'warning';
  return 'warning';
}

function buildMonitorNotificationBody(
  record: MonitorRecord,
  trigger: MonitorTrigger,
  detail: MonitorFireDetail,
): string {
  const lines: string[] = [];
  if (record.description !== undefined && record.description.length > 0) {
    lines.push(`Monitor: ${record.description}`);
  }
  lines.push(`Type: ${record.type}`);
  if (record.command !== undefined) lines.push(`Command: ${record.command}`);
  if (record.type === 'task_output' && record.taskId !== undefined) {
    lines.push(`Task: ${record.taskId}`);
  }
  if (record.path !== undefined) lines.push(`Path: ${record.path}`);
  if (record.pattern !== undefined) lines.push(`Pattern: ${record.pattern}`);
  switch (trigger) {
    case 'match':
      if (detail.matchedLine !== undefined) lines.push(`Matched line: ${detail.matchedLine}`);
      if (detail.changedPath !== undefined) lines.push(`Changed path: ${detail.changedPath}`);
      lines.push(
        'The monitor fired on its first match and has ended. Create a new monitor if you need to keep watching.',
      );
      break;
    case 'exit':
      lines.push(
        `The monitored command exited (code ${String(detail.exitCode ?? 'unknown')}) before any pattern matched. The monitor has ended.`,
      );
      break;
    case 'timeout':
      lines.push(
        `The monitor timed out after ${String(Math.round(record.timeoutMs / 1000))}s without firing. Create a new monitor if you need to keep watching.`,
      );
      break;
  }
  lines.push(`Triggered at: ${new Date(record.endedAt ?? Date.now()).toISOString()}`);
  return lines.join('\n');
}

function generateMonitorId(): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < 8; index++) {
    suffix += MONITOR_ID_ALPHABET[bytes[index]! % MONITOR_ID_ALPHABET.length];
  }
  return `monitor-${suffix}`;
}

function normalizeSlashes(path: string): string {
  return path.replaceAll('\\', '/');
}

function canonicalizeForWatch(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    if (existsSync(current)) {
      try {
        const real = realpathSync(current);
        return missing.length === 0 ? real : join(real, ...missing);
      } catch {
        return target;
      }
    }
    const parent = dirname(current);
    if (parent === current) return target;
    missing.unshift(basename(current));
    current = parent;
  }
}

function staticWatchRoot(absoluteGlob: string): string {
  const segments = normalizeSlashes(absoluteGlob).split('/');
  const kept: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    kept.push(segment);
  }
  const root = kept.join('/');
  return root === '' ? '/' : root;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) {
    return path.replaceAll('\\', '/');
  }
  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll('\\', '/');
    return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
  }
  return path.replaceAll('\\', '/');
}

async function disposeQuietly(proc: IHostProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMonitorService,
  AgentMonitorService,
  ScopeActivation.OnScopeCreated,
  'agentMonitor',
);
