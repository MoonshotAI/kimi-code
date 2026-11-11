import { event2FromRecord } from '#/app/event/event2';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolExecutorService, type AgentToolExecutionHandler } from '#/agent/toolExecutor/toolExecutor';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { ToolTimeoutError } from '#/tool/executor/types';
import { userCancellationReason } from '#/_base/utils/abort';
import { codePointBoundaryStart } from '#/_base/text/code-points';
import { TERMINAL_STATUSES } from './types';
import { taskKey, TaskStarted, TaskTerminated } from './taskOps';
import type { AgentTaskInfo, AgentTaskStatus } from './types';
import { agentTaskInfo } from './handler';
import { emptyOutputSnapshot, IAgentTaskOutputService } from './taskOutput';
import { IAgentTaskService } from './task';
import type { AgentTaskOutputSnapshot, AgentTaskOutputTail } from './task';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { WAIT_FOR_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import { IFlagService } from '#/app/flag/flag';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

export function isAgentTaskTerminal(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class AgentTaskService {
  private readonly history = new Map<string, AgentTaskInfo>();

  constructor(private readonly agentId: string) {}

  restore(records: readonly WireRecord[]): void {
    this.history.clear();
    for (const record of records) {
      if (record['agentId'] !== this.agentId) continue;
      const cls = record.type === TaskStarted.type
        ? TaskStarted
        : record.type === TaskTerminated.type
          ? TaskTerminated
          : undefined;
      if (cls === undefined) continue;
      const event = event2FromRecord(cls, record);
      if (!(event instanceof TaskStarted) && !(event instanceof TaskTerminated)) continue;
      const info = event.info.status === 'running' ? { ...event.info, status: 'lost' as const } : event.info;
      this.history.set(info.taskId, info);
    }
  }

  get(taskId: string): AgentTaskInfo | undefined {
    return this.history.get(taskId);
  }

  values(): IterableIterator<AgentTaskInfo> {
    return this.history.values();
  }

  [Symbol.iterator](): IterableIterator<[string, AgentTaskInfo]> {
    return this.history[Symbol.iterator]();
  }

  list(activeOnly: boolean, limit?: number): readonly AgentTaskInfo[] {
    return listTasks(this.history.values(), activeOnly, limit);
  }
}

function shouldListTask(info: AgentTaskInfo, activeOnly: boolean): boolean {
  if (!TERMINAL_STATUSES.has(info.status)) return true;
  if (activeOnly) return false;
  return info.detached !== false;
}

function listTasks(
  tasks: Iterable<AgentTaskInfo>,
  activeOnly: boolean,
  limit?: number,
): readonly AgentTaskInfo[] {
  const result: AgentTaskInfo[] = [];
  for (const info of tasks) {
    if (!shouldListTask(info, activeOnly)) continue;
    result.push(info);
    if (limit !== undefined && result.length >= limit) break;
  }
  return result;
}

export interface IAgentTaskHistoryService {
  readonly _serviceBrand: undefined;
  reconcile(): Promise<void>;
  getTask(taskId: string): AgentTaskInfo | undefined;
  list(activeOnly: boolean, limit?: number): readonly AgentTaskInfo[];
  values(): IterableIterator<AgentTaskInfo>;
}

export const IAgentTaskHistoryService = createDecorator<IAgentTaskHistoryService>('agentTaskHistoryService');

const SUBAGENT_BACKGROUND_TASK_NOTICE =
  'You are running as a subagent: ending your turn is your final hand-off to the parent agent, and completion notifications that arrive after it reach no one. Do not end your turn while a background task whose result you need is still running. Keep waiting for it with WaitFor, calling it again after a timeout if needed, or run the command in the foreground with a suitable timeout instead. Still use the waiting time for other useful work on your task when you can.';

export class AgentTaskHistoryService extends Service implements IAgentTaskHistoryService {
  declare readonly _serviceBrand: undefined;
  private readonly restored: AgentTaskService;
  private readonly lost = new Set<string>();

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IWireService private readonly wire: IWireService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentReminderService reminder: IAgentReminderService,
    @IFlagService flags: IFlagService,
    @IAgentToolRegistryService tools: IAgentToolRegistryService,
    @IAgentToolPolicyService policy: IAgentToolPolicyService,
  ) {
    super();
    this.restored = new AgentTaskService(scopeContext.agentId);
    this.states.contributeState(taskKey);
    this._register(dispatcher.hooks.onDidRestore.register('task.history', async (_ctx, next) => {
      await this.reconcile();
      await next();
    }));
    if (scopeContext.agentId !== MAIN_AGENT_ID) {
      this._register(
        reminder.register('subagent_background_task', ({ lastInjectedAt }) => {
          if (
            lastInjectedAt !== null ||
            !flags.enabled(WAIT_FOR_FLAG_ID) ||
            tools.resolve('WaitFor') === undefined ||
            !policy.isToolActive('WaitFor')
          ) return undefined;
          return SUBAGENT_BACKGROUND_TASK_NOTICE;
        }),
      );
    }
  }

  async reconcile(): Promise<void> {
    const { journal } = await this.wire.readRestoreChains();
    this.restored.restore(journal);
    this.lost.clear();
    for (const info of this.restored.values()) {
      if (info.status === 'lost') this.lost.add(info.taskId);
    }
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    const info = this.states.get(taskKey).get(taskId);
    return info?.status === 'running' && this.lost.has(taskId) ? { ...info, status: 'lost' } : info;
  }

  list(activeOnly: boolean, limit?: number): readonly AgentTaskInfo[] {
    return listTasks(this.values(), activeOnly, limit);
  }

  *values(): IterableIterator<AgentTaskInfo> {
    for (const info of this.states.get(taskKey).values()) {
      yield info.status === 'running' && this.lost.has(info.taskId) ? { ...info, status: 'lost' } : info;
    }
  }
}

export class AgentTaskRequestService extends Service implements IAgentTaskService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChangeTask = this._register(new Emitter<AgentTaskInfo>());
  readonly onDidChangeTask = this._onDidChangeTask.event;
  private readonly pendingChanges = new Set<AgentToolExecutionHandler>();
  private disposed = false;

  constructor(
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentTaskHistoryService private readonly history: IAgentTaskHistoryService,
    @IAgentTaskOutputService private readonly outputs: IAgentTaskOutputService,
  ) {
    super();
    this._register(this.toolExecutor.registerHook({
      observe: (event) => {
        if (event.type !== 'change' || event.handler.snapshot().fields['task'] === undefined) return;
        this.scheduleChange(event.handler);
      },
    }));
    this._register({
      dispose: () => {
        this.disposed = true;
        this.pendingChanges.clear();
      },
    });
  }

  private scheduleChange(handler: AgentToolExecutionHandler): void {
    if (this.disposed || this.pendingChanges.has(handler)) return;
    this.pendingChanges.add(handler);
    queueMicrotask(() => {
      this.pendingChanges.delete(handler);
      if (this.disposed || handler.snapshot().fields.task === undefined) return;
      this._onDidChangeTask.fire(agentTaskInfo(handler));
    });
  }

  getTask(taskId: string): AgentTaskInfo | undefined {
    const handler = this.toolExecutor.handler(taskId);
    if (handler?.snapshot().fields.task !== undefined) return agentTaskInfo(handler);
    return this.history.getTask(taskId);
  }

  list(activeOnly = false, limit?: number): readonly AgentTaskInfo[] {
    const tasks = new Map<string, AgentTaskInfo>();
    for (const handler of this.toolExecutor.handlers()) {
      if (handler.snapshot().fields.task === undefined) continue;
      const info = agentTaskInfo(handler);
      tasks.set(info.taskId, info);
    }
    for (const info of this.history.values()) {
      if (!tasks.has(info.taskId)) tasks.set(info.taskId, info);
    }
    return listTasks(tasks.values(), activeOnly, limit);
  }

  detach(taskId: string, text?: string): AgentTaskInfo | undefined {
    this.toolExecutor.handler(taskId)?.detach(text);
    return this.getTask(taskId);
  }

  async stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined> {
    const trimmed = reason?.trim();
    await this.toolExecutor.handler(taskId)?.stop(trimmed === '' ? undefined : trimmed);
    return this.getTask(taskId);
  }

  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined> {
    return this.stop(taskId, userCancellationReason().message);
  }

  async wait(taskId: string, timeoutMs?: number, signal?: AbortSignal): Promise<AgentTaskInfo | undefined> {
    const handler = this.toolExecutor.handler(taskId);
    if (handler === undefined) return this.history.getTask(taskId);
    try {
      await handler.wait(timeoutMs, signal);
    } catch (error) {
      if (!(error instanceof ToolTimeoutError)) throw error;
    }
    return handler.snapshot().fields.task === undefined ? this.history.getTask(taskId) : agentTaskInfo(handler);
  }

  async getOutputSnapshot(taskId: string, maxPreviewBytes: number): Promise<AgentTaskOutputSnapshot> {
    const live = this.toolExecutor.handler(taskId)?.output(maxPreviewBytes);
    if (live !== undefined) {
      return {
        outputPath: live.path,
        outputSizeBytes: live.totalBytes,
        previewBytes: Buffer.byteLength(live.preview),
        truncated: live.truncated,
        fullOutputAvailable: live.path !== undefined,
        preview: live.preview,
      };
    }
    const persisted = await this.outputs.readTaskOutputSnapshot(taskId, maxPreviewBytes);
    return persisted === undefined ? emptyOutputSnapshot() : { ...persisted, fullOutputAvailable: true };
  }

  async readOutputTail(taskId: string, maxBytes: number): Promise<AgentTaskOutputTail> {
    if (this.getTask(taskId) === undefined) return { offset: 0, data: new Uint8Array() };
    const persisted = await this.outputs.readTaskOutputTail(taskId, maxBytes);
    if (persisted !== undefined) return persisted;
    const live = this.toolExecutor.handler(taskId)?.output(maxBytes);
    if (live === undefined) return { offset: 0, data: new Uint8Array() };
    const data = Buffer.from(live.preview, 'utf-8');
    return { offset: live.totalBytes - data.byteLength, data };
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const output = (await this.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)).preview;
    if (tail === undefined) return output;
    const tailChars = Math.max(0, Math.trunc(tail));
    if (tailChars === 0) return output;
    return output.slice(codePointBoundaryStart(output, Math.max(0, output.length - tailChars)));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTaskHistoryService,
  AgentTaskHistoryService,
  ScopeActivation.OnScopeCreated,
  'taskHistory',
);

registerScopedService(
  LifecycleScope.Agent,
  IAgentTaskService,
  AgentTaskRequestService,
  ScopeActivation.OnScopeCreated,
  'taskRequests',
);
