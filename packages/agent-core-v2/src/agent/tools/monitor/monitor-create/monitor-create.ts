import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MONITOR_DEFAULT_TIMEOUT_S = 3600;
export const MONITOR_MAX_TIMEOUT_S = 86400;

const timeoutField = z
  .number()
  .int()
  .positive()
  .max(MONITOR_MAX_TIMEOUT_S)
  .optional()
  .describe(
    `Seconds before the monitor fires a timeout notification (default ${String(MONITOR_DEFAULT_TIMEOUT_S)}, max ${String(MONITOR_MAX_TIMEOUT_S)}).`,
  );

const descriptionField = z
  .string()
  .optional()
  .describe('Short description of what this monitor is waiting for, shown in notifications.');

export const MonitorCreateInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z
      .literal('task_output')
      .describe('Watch the stdout/stderr of a background task owned by this agent.'),
    task_id: z.string().describe('The background task ID to watch.'),
    pattern: z
      .string()
      .describe(
        'Regular expression matched line by line against the task output. The monitor fires on the first matching line; do not rely on anchors that span multiple lines.',
      ),
    timeout: timeoutField,
    description: descriptionField,
  }),
  z.object({
    type: z
      .literal('command')
      .describe('Run a shell command (e.g. `tail -f app.log`) and watch its output.'),
    command: z.string().describe('The shell command to run.'),
    pattern: z
      .string()
      .optional()
      .describe(
        'Regular expression matched line by line against the command output. The monitor fires on the first matching line and then terminates the command. When omitted, the monitor fires when the command exits.',
      ),
    timeout: timeoutField,
    description: descriptionField,
  }),
  z.object({
    type: z.literal('file').describe('Watch a file, directory, or glob for changes.'),
    path: z
      .string()
      .describe(
        'Absolute or cwd-relative path to a file or directory, or a glob pattern (e.g. `dist/**/*.js`).',
      ),
    events: z
      .array(z.enum(['created', 'modified']))
      .optional()
      .describe('Which change kinds fire the monitor. Defaults to both created and modified.'),
    timeout: timeoutField,
    description: descriptionField,
  }),
]);

export type MonitorCreateInput = z.infer<typeof MonitorCreateInputSchema>;

export interface IMonitorCreateTool extends AgentTool<MonitorCreateInput> { readonly _serviceBrand: undefined }
export const IMonitorCreateTool = createDecorator<IMonitorCreateTool>('monitorCreateTool');
