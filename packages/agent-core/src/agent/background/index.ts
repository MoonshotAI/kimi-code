import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../..';
import type { TelemetryPropertyValue } from '../../telemetry';
import {
  BackgroundProcessManager,
  type BackgroundProcessManagerOptions,
  type BackgroundTaskInfo,
  isBackgroundTaskTerminal,
  type ReconcileResult,
} from '../../tools/builtin';
import type { BackgroundTaskOrigin } from '../context';
import { renderNotificationXml } from '../context/notification-xml';

type BackgroundTaskNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly tail_output: string;
};

interface BackgroundTaskNotificationContext {
  readonly content: readonly ContentPart[];
  readonly origin: BackgroundTaskOrigin;
  readonly notification: BackgroundTaskNotification;
}

const NOTIFICATION_TAIL_BYTES = 3_000;

export class BackgroundManager extends BackgroundProcessManager {
  private readonly scheduledNotificationKeys = new Set<string>();
  private readonly deliveredNotificationKeys = new Set<string>();

  constructor(
    public readonly agent: Agent,
    options: BackgroundProcessManagerOptions = {},
  ) {
    super(options);

    this.onLifecycle((event, info) => {
      switch (event) {
        case 'started':
          this.agent.emitEvent({ type: 'background.task.started', info });
          this.agent.telemetry.track('background_task_created', {
            kind: info.taskId.startsWith('agent-') ? 'agent' : 'bash',
          });
          return;
        case 'updated':
          this.agent.emitEvent({ type: 'background.task.updated', info });
          return;
        case 'terminated': {
          this.agent.emitEvent({ type: 'background.task.terminated', info });
          const success = info.status === 'completed';
          const duration_s =
            info.endedAt !== null ? (info.endedAt - info.startedAt) / 1000 : null;
          const properties: Record<string, TelemetryPropertyValue> = {
            kind: info.taskId.startsWith('agent-') ? 'agent' : 'bash',
            success,
            duration_s,
          };
          if (!success) {
            properties['reason'] =
              info.timedOut === true
                ? 'timeout'
                : info.status === 'killed'
                  ? 'killed'
                  : 'error';
          }
          this.agent.telemetry.track('background_task_completed', properties);
          return;
        }
      }
    });
  }

  override async reconcile(): Promise<ReconcileResult> {
    const result = await super.reconcile();
    await this.restoreBackgroundTaskNotifications();
    return result;
  }

  protected override onLiveTaskTerminal(info: BackgroundTaskInfo): void | Promise<void> {
    return this.notifyBackgroundTask(info);
  }

  private async restoreBackgroundTaskNotifications(): Promise<void> {
    for (const info of this.list(false)) {
      if (!isBackgroundTaskTerminal(info.status)) continue;
      await this.restoreBackgroundTaskNotification(info);
    }
  }

  private async notifyBackgroundTask(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.turn.steer(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async restoreBackgroundTaskNotification(info: BackgroundTaskInfo): Promise<void> {
    const context = await this.buildBackgroundTaskNotificationContext(info);
    if (context === undefined) return;
    this.agent.context.appendUserMessage(context.content, context.origin);
    this.fireNotificationHook(context.notification);
  }

  private async buildBackgroundTaskNotificationContext(
    info: BackgroundTaskInfo,
  ): Promise<BackgroundTaskNotificationContext | undefined> {
    const origin: BackgroundTaskOrigin = {
      kind: 'background_task',
      taskId: info.taskId,
      status: info.status,
      notificationId: `task:${info.taskId}:${info.status}`,
    };
    const notificationId = origin.notificationId;
    const key = notificationKey(origin);
    if (this.scheduledNotificationKeys.has(key)) return;
    if (this.hasDeliveredNotification(origin)) return;

    this.scheduledNotificationKeys.add(key);
    const tailOutput = (await this.getOutputSnapshot(info.taskId, NOTIFICATION_TAIL_BYTES))
      .preview;
    if (this.hasDeliveredNotification(origin)) return;
    const label = info.taskId.startsWith('agent-') ? 'agent' : 'task';
    const notification: BackgroundTaskNotification = {
      id: notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      title: `Background ${label} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: `${info.description} ${info.status}.`,
      tail_output: tailOutput,
    };
    const content = [
      {
        type: 'text',
        text: renderNotificationXml(notification),
      },
    ] as const;
    return { content, origin, notification };
  }

  private fireNotificationHook(notification: BackgroundTaskNotification): void {
    void this.agent.hooks?.fireAndForgetTrigger('Notification', {
      matcherValue: notification.type,
      inputData: {
        sink: 'context',
        notificationType: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        sourceKind: notification.source_kind,
        sourceId: notification.source_id,
      },
    });
  }

  markDeliveredNotification(origin: BackgroundTaskOrigin): void {
    this.deliveredNotificationKeys.add(notificationKey(origin));
  }

  private hasDeliveredNotification(origin: BackgroundTaskOrigin): boolean {
    return this.deliveredNotificationKeys.has(notificationKey(origin));
  }

  override stop(taskId: string, reason?: string) {
    this.agent.records.logRecord({
      type: 'background.stop',
      taskId,
    });
    return super.stop(taskId, reason);
  }

  override _reset(): void {
    super._reset();
    this.scheduledNotificationKeys.clear();
    this.deliveredNotificationKeys.clear();
  }
}

function notificationKey(origin: BackgroundTaskOrigin): string {
  return `${origin.taskId}\0${origin.status}\0${origin.notificationId}`;
}
