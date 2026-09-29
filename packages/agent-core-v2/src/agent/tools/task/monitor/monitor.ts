import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MONITOR_TASK_ID_PREFIX = 'monitor';
export const MONITOR_DEFAULT_TIMEOUT_S = 5 * 60;

export function isMonitorTaskId(taskId: string): boolean {
  return taskId.startsWith(`${MONITOR_TASK_ID_PREFIX}-`);
}
export const MONITOR_MAX_TIMEOUT_S = 60 * 60;

export const MonitorInputSchema = z.object({
  command: z
    .string()
    .min(1, 'Command cannot be empty.')
    .describe('The shell command to run. Each line it prints to stdout is delivered to you as an event.'),
  description: z
    .string()
    .min(1, 'Description cannot be empty.')
    .describe('A short description of what is being monitored. It titles every event notification.'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MONITOR_MAX_TIMEOUT_S)
    .optional()
    .describe(
      `Seconds before the monitor is stopped. Default ${String(MONITOR_DEFAULT_TIMEOUT_S)}, max ${String(MONITOR_MAX_TIMEOUT_S)}. Ignored when persistent is true.`,
    ),
  persistent: z
    .boolean()
    .optional()
    .describe('Keep the monitor running until you stop it with TaskStop or the session ends.'),
});

export type MonitorInput = z.infer<typeof MonitorInputSchema>;

export interface IMonitorTool extends AgentTool<MonitorInput> { readonly _serviceBrand: undefined }
export const IMonitorTool = createDecorator<IMonitorTool>('monitorTool');
