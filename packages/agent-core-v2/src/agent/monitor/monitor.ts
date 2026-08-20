/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import type { MonitorOrigin } from '#/agent/contextMemory/types';

export type MonitorType = 'task_output' | 'command' | 'file';

export type MonitorTrigger = 'match' | 'exit' | 'timeout';

export type MonitorFileEvent = 'created' | 'modified';

export type MonitorStatus = 'active' | 'fired' | 'cancelled' | 'ended' | 'lost';

export const MONITOR_MAX_ACTIVE = 20;

export interface MonitorSpecBase {
  readonly timeoutMs: number;
  readonly description?: string;
}

export interface TaskOutputMonitorSpec extends MonitorSpecBase {
  readonly type: 'task_output';
  readonly taskId: string;
  readonly pattern: string;
}

export interface CommandMonitorSpec extends MonitorSpecBase {
  readonly type: 'command';
  readonly command: string;
  readonly pattern?: string;
}

export interface FileMonitorSpec extends MonitorSpecBase {
  readonly type: 'file';
  readonly path: string;
  readonly events?: readonly MonitorFileEvent[];
  readonly pattern?: string;
}

export type MonitorSpec = TaskOutputMonitorSpec | CommandMonitorSpec | FileMonitorSpec;

export interface MonitorInfo {
  readonly monitorId: string;
  readonly type: MonitorType;
  readonly status: MonitorStatus;
  readonly description?: string;
  readonly timeoutMs: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly trigger?: MonitorTrigger;
  readonly taskId?: string;
  readonly pattern?: string;
  readonly command?: string;
  readonly path?: string;
  readonly events?: readonly MonitorFileEvent[];
}

export type MonitorNotification = Record<string, unknown> & {
  readonly id: string;
  readonly category: 'monitor';
  readonly type: string;
  readonly source_kind: 'monitor';
  readonly source_id: string;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
};

export interface MonitorFiredNotification {
  readonly origin: MonitorOrigin;
  readonly notification: MonitorNotification;
}

export interface MonitorNotificationContext {
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning';
  readonly sourceKind: string;
  readonly sourceId: string;
}

export class MonitorNotified extends Event2<MonitorNotificationContext> {
  static override readonly type = 'monitor.notified';
  static override readonly observable = true;
}
export interface MonitorNotified extends MonitorNotificationContext {}

export interface IAgentMonitorService {
  readonly _serviceBrand: undefined;

  createMonitor(spec: MonitorSpec): Promise<MonitorInfo>;
  listMonitors(): readonly MonitorInfo[];
  cancelMonitor(monitorId: string): Promise<MonitorInfo | undefined>;
}

export const IAgentMonitorService: ServiceIdentifier<IAgentMonitorService> =
  createDecorator<IAgentMonitorService>('agentMonitorService');

export function isMonitorOrigin(origin: unknown): origin is MonitorOrigin {
  if (typeof origin !== 'object' || origin === null) return false;
  const value = origin as Record<string, unknown>;
  return (
    value['kind'] === 'monitor' &&
    typeof value['monitorId'] === 'string' &&
    typeof value['monitorType'] === 'string' &&
    typeof value['trigger'] === 'string' &&
    typeof value['notificationId'] === 'string'
  );
}

export function monitorNotificationKey(
  origin: Pick<MonitorOrigin, 'monitorId' | 'trigger' | 'notificationId'>,
): string {
  return `${origin.monitorId}\0${origin.trigger}\0${origin.notificationId}`;
}

function monitorOriginFromMessage(message: unknown): MonitorOrigin | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const origin = (message as { readonly origin?: unknown }).origin;
  return isMonitorOrigin(origin) ? origin : undefined;
}

export const monitorNotificationDeliveryKey = defineState(
  'monitor.notificationDelivery',
  (): readonly string[] => [],
)
  .replayable({ schema: z.custom<readonly string[]>() })
  .undoable()
  .on(ContextAppendMessage, (s, e) => {
    const origin = monitorOriginFromMessage(e.message);
    if (origin === undefined) return;
    const key = monitorNotificationKey(origin);
    if (!s.includes(key)) {
      s.push(key);
    }
  });

export const monitorScheduledNotificationKeysKey = defineState<Set<string>>(
  'monitor.scheduledNotificationKeys',
  () => new Set(),
);
export const monitorDeliveredNotificationKeysKey = defineState<Set<string>>(
  'monitor.deliveredNotificationKeys',
  () => new Set(),
);
