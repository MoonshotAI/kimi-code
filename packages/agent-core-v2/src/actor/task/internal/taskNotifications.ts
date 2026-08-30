import type { ContentPart } from '#/kosong/contract/message';

import { ILogService } from '#/_base/log/log';
import { userCancellationReason } from '#/_base/utils/abort';
import { escapeXml, escapeXmlAttr } from '#/_base/utils/xml-escape';
import '#/actor/contextMemory/conversationTime';
import type { ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import type { ContextMessage, TaskOrigin } from '#/actor/contextMemory/types';
import { getLoopControl } from '#/actor/loop/internal/access';
import { MessageStepRequest } from '#/actor/loop/internal/stepRequest';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { IEventDispatcher } from '#/state/eventDispatcher';

import {
  notificationKey,
  taskNotificationDeliveryKey,
  taskNotificationId,
  isTaskOrigin,
  type TaskNotificationOrigin,
} from '../notificationDelivery';
import { TaskNotified } from '../taskOps';
import type { AgentTaskInfo, AgentTaskOutputSnapshot } from '../types';
import { emptyOutputSnapshot, isAgentTaskTerminal } from './taskEntryMachine';
import { renderNotificationXml } from './notificationXml';

const NOTIFICATION_FALLBACK_PREVIEW_BYTES = 3_000;

type AgentTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
};

interface AgentTaskNotificationBuildContext {
  readonly content: readonly ContentPart[];
  readonly origin: TaskOrigin;
  readonly notification: AgentTaskNotification;
}

export class TaskNotificationStepRequest extends MessageStepRequest {
  constructor(
    message: ContextMessage,
    private readonly onWillDeliver?: () => void,
  ) {
    super(message, {
      kind: 'task_notification',
      mergeable: true,
      turnScoped: false,
      admission: 'activeOrNewTurn',
    });
  }

  override onWillMaterialize(): void {
    this.onWillDeliver?.();
  }
}

export interface TaskNotificationLedger {
  readonly scheduledKeys: Set<string>;
  readonly deliveredKeys: Set<string>;
  readonly buildingKeys: Set<string>;
  readonly pendingRequests: Map<string, TaskNotificationStepRequest>;
  restoreQueue: Promise<void>;
  disposed: boolean;
}

export function createTaskNotificationLedger(): TaskNotificationLedger {
  return {
    scheduledKeys: new Set(),
    deliveredKeys: new Set(),
    buildingKeys: new Set(),
    pendingRequests: new Map(),
    restoreQueue: Promise.resolve(),
    disposed: false,
  };
}

export interface TaskNotificationHost {
  readonly agent: AgentContext;
  readonly dispatcher: IEventDispatcher;
  readonly log: ILogService;
  readonly states: IAgentStateService;
  readonly contextMemory: ContextMemoryRuntime;
  readonly ledger: TaskNotificationLedger;
  listInfos(activeOnly: boolean): readonly AgentTaskInfo[];
  isSuppressed(taskId: string): boolean;
  outputSnapshot(taskId: string, maxPreviewBytes: number): Promise<AgentTaskOutputSnapshot>;
}

export function seedDeliveredNotificationKeys(host: TaskNotificationHost): void {
  for (const key of host.states.get(taskNotificationDeliveryKey)) {
    host.ledger.deliveredKeys.add(key);
  }
}

export function markDeliveredNotification(
  ledger: TaskNotificationLedger,
  origin: TaskNotificationOrigin,
): void {
  const key = notificationKey(origin);
  ledger.scheduledKeys.delete(key);
  ledger.pendingRequests.delete(key);
  ledger.deliveredKeys.add(key);
}

export function markDeliveredMessageOrigins(
  ledger: TaskNotificationLedger,
  messages: readonly { readonly origin?: unknown }[],
): void {
  for (const message of messages) {
    if (isTaskOrigin(message.origin)) {
      markDeliveredNotification(ledger, message.origin);
    }
  }
}

function hasDeliveredNotification(host: TaskNotificationHost, key: string): boolean {
  if (host.ledger.disposed) return false;
  return host.contextMemory.get().some((message) => {
    return isTaskOrigin(message.origin) && notificationKey(message.origin) === key;
  });
}

function clearPendingNotification(
  host: TaskNotificationHost,
  key: string,
  request: TaskNotificationStepRequest,
): void {
  const ledger = host.ledger;
  if (ledger.pendingRequests.get(key) !== request) return;
  ledger.pendingRequests.delete(key);
  if (!ledger.deliveredKeys.has(key) && !hasDeliveredNotification(host, key)) {
    ledger.scheduledKeys.delete(key);
  }
}

export async function notifyAgentTask(
  host: TaskNotificationHost,
  info: AgentTaskInfo,
): Promise<void> {
  const context = await buildAgentTaskNotificationContext(host, info);
  if (context === undefined) return;
  const key = notificationKey(context.origin);
  if (host.ledger.deliveredKeys.has(key)) return;
  const request = new TaskNotificationStepRequest(
    {
      role: 'user',
      content: [...context.content],
      toolCalls: [],
      origin: context.origin,
    },
    () => {
      fireNotificationHook(host, context.notification);
    },
  );
  host.ledger.pendingRequests.set(key, request);
  try {
    const receipt = getLoopControl(host.agent).enqueue(request);
    void receipt.assigned
      .then(({ step }) => step.result)
      .then(
        () => {
          if (request.aborted) clearPendingNotification(host, key, request);
        },
        () => {
          clearPendingNotification(host, key, request);
        },
      );
  } catch (error) {
    clearPendingNotification(host, key, request);
    throw error;
  }
}

export function restoreAgentTaskNotifications(host: TaskNotificationHost): Promise<void> {
  const restore = host.ledger.restoreQueue.then(() => restoreAgentTaskNotificationsNow(host));
  host.ledger.restoreQueue = restore.catch(() => {});
  return restore;
}

async function restoreAgentTaskNotificationsNow(host: TaskNotificationHost): Promise<void> {
  for (const info of host.listInfos(false)) {
    if (!isAgentTaskTerminal(info.status)) continue;
    await restoreAgentTaskNotification(host, info);
  }
}

async function restoreAgentTaskNotification(
  host: TaskNotificationHost,
  info: AgentTaskInfo,
): Promise<void> {
  const context = await buildAgentTaskNotificationContext(host, info);
  if (context === undefined) return;
  void host.contextMemory.append({
    role: 'user',
    content: [...context.content],
    toolCalls: [],
    origin: context.origin,
  });
  fireNotificationHook(host, context.notification);
}

async function buildAgentTaskNotificationContext(
  host: TaskNotificationHost,
  info: AgentTaskInfo,
): Promise<AgentTaskNotificationBuildContext | undefined> {
  if (info.detached === false) return undefined;
  if (info.terminalNotificationSuppressed === true) return undefined;
  const ledger = host.ledger;
  const origin: TaskOrigin = {
    kind: 'task',
    taskId: info.taskId,
    status: info.status,
    notificationId: taskNotificationId(info.taskId, info.status),
  };
  const key = notificationKey(origin);
  if (ledger.buildingKeys.has(key)) return undefined;
  if (ledger.scheduledKeys.has(key)) return undefined;
  if (ledger.deliveredKeys.has(key)) return undefined;
  if (hasDeliveredNotification(host, key)) return undefined;
  ledger.buildingKeys.add(key);
  try {
    let output = emptyOutputSnapshot();
    try {
      output = await host.outputSnapshot(info.taskId, 0);
      if (!output.fullOutputAvailable) {
        output = await host.outputSnapshot(info.taskId, NOTIFICATION_FALLBACK_PREVIEW_BYTES);
      }
    } catch (error) {
      host.log.error('task notification output read failed; delivering without output', {
        taskId: info.taskId,
        error,
      });
    }
    if (host.isSuppressed(info.taskId)) return undefined;
    if (ledger.scheduledKeys.has(key)) return undefined;
    if (ledger.deliveredKeys.has(key)) return undefined;
    if (hasDeliveredNotification(host, key)) return undefined;
    ledger.scheduledKeys.add(key);
    const notification: AgentTaskNotification = {
      id: origin.notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Background ${info.kind} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildAgentTaskNotificationBody(info),
      children: agentTaskNotificationChildren(output),
    };
    const content = [
      {
        type: 'text',
        text: renderNotificationXml(notification),
      },
    ] as const;
    return { content, origin, notification };
  } finally {
    ledger.buildingKeys.delete(key);
  }
}

function fireNotificationHook(
  host: TaskNotificationHost,
  notification: AgentTaskNotification,
): void {
  void host.dispatcher.dispatch(
    new TaskNotified({
      agentId: host.agent.agentId,
      notificationType: notification.type,
      title: notification.title,
      body: notification.body,
      severity: notification.severity,
      sourceKind: notification.source_kind,
      sourceId: notification.source_id,
    }),
  );
}

export async function reconcileNotificationDeliveryAfterUndo(
  host: TaskNotificationHost,
): Promise<void> {
  const ledger = host.ledger;
  const restoredKeys = new Set(host.states.get(taskNotificationDeliveryKey));
  for (const [key, request] of ledger.pendingRequests) {
    if (request.aborted) clearPendingNotification(host, key, request);
  }
  ledger.deliveredKeys.clear();
  for (const key of restoredKeys) ledger.deliveredKeys.add(key);
  for (const key of ledger.scheduledKeys) {
    if (restoredKeys.has(key) || !ledger.pendingRequests.has(key)) {
      ledger.scheduledKeys.delete(key);
    }
  }
  await restoreAgentTaskNotifications(host);
}

function agentTaskNotificationChildren(
  output: AgentTaskOutputSnapshot,
): readonly string[] | undefined {
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function renderOutputFileBlock(outputPath: string, outputSizeBytes: number): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    '</output-file>',
  ].join('\n');
}

function renderOutputPreviewBlock(output: AgentTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

function buildAgentTaskNotificationBody(info: AgentTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.status === 'killed' && isSerializedUserCancellation(info.stopReason)
        ? `${info.description} was stopped by user.`
        : info.stopReason
          ? `${info.description} ${info.status === 'killed' ? 'was stopped' : info.status}. Reason: ${info.stopReason}`
          : `${info.description} ${info.status}.`;

  if (info.kind !== 'agent') return baseLine;
  if (info.status === 'completed') return baseLine;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return baseLine;

  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');

  return `${baseLine}${recovery}`;
}

function isSerializedUserCancellation(reason: string | undefined): boolean {
  return reason === userCancellationReason().message;
}
