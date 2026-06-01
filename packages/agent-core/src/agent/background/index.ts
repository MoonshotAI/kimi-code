import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../..';
import type { TelemetryPropertyValue } from '../../telemetry';
import {
  BackgroundProcessManager,
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
  /** Subagent id for agent-* tasks. Surfaced as a structured attribute so
   *  the LLM can pass it verbatim to `Agent(resume=...)` without confusing
   *  it with `source_id` (the BackgroundManager ledger id). Omitted for
   *  bash background tasks and for restored tasks whose previous session
   *  pre-dates agent_id persistence. */
  readonly agent_id?: string | undefined;
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

  constructor(public readonly agent: Agent) {
    super({
      maxRunningTasks: agent.kimiConfig?.background?.maxRunningTasks,
      sessionDir: agent.homedir,
    });

    this.onLifecycle((event, info) => {
      switch (event) {
        case 'started':
          this.agent.emitEvent({ type: 'background.task.started', info });
          this.agent.telemetry.track('background_task_created', {
            kind: info.kind === 'agent' ? 'agent' : 'bash',
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
            kind: info.kind === 'agent' ? 'agent' : 'bash',
            success,
            duration_s,
          };
          if (!success) {
            properties['reason'] =
              info.status === 'timed_out'
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
    const isAgentTask = info.kind === 'agent';
    const label = isAgentTask ? 'agent' : 'task';
    const notification: BackgroundTaskNotification = {
      id: notificationId,
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      agent_id: info.kind === 'agent' ? info.agentId : undefined,
      title: `Background ${label} ${info.status}`,
      severity: info.status === 'completed' ? 'info' : 'warning',
      body: buildBackgroundTaskNotificationBody(info),
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

/**
 * Build the human/LLM-readable body that lands in the `<notification>`
 * XML. For agent-* tasks that ended non-successfully and whose subagent id
 * we still know, append a paragraph telling the LLM exactly how to resume
 * — which id to pass, how to distinguish it from the look-alike `source_id`,
 * and what state the resumed subagent will and will not have. The intent is
 * to make recovery a one-shot decision instead of a memory lookup against
 * the original spawn-success ToolResult.
 *
 * Bash tasks, successful agent tasks, and restored agent tasks from
 * sessions that pre-date `agent_id` persistence keep the original
 * single-sentence body.
 */
function buildBackgroundTaskNotificationBody(info: BackgroundTaskInfo): string {
  const baseLine =
    info.status === 'timed_out'
      ? `${info.description} timed out.`
      : info.stopReason
      ? `${info.description} ${info.status === 'killed' ? 'was killed' : info.status}: ${
          info.stopReason
        }.`
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
