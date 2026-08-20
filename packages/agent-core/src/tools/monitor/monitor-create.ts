/**
 * MonitorCreateTool — register a one-shot, event-driven watcher that
 * pushes a notification back into this session when it fires, replacing
 * polling loops (repeated TaskOutput / Bash sleeps) that burn tokens and
 * add latency.
 *
 * Three watcher types, selected by the `type` discriminator:
 *
 *   - `task_output`: watch a live background task's stdout/stderr and
 *     fire the moment a line matches `pattern` — no waiting for the task
 *     to finish. If the task ends without a match the monitor ends
 *     silently.
 *   - `command`: run an arbitrary shell command (e.g. `tail -f app.log`)
 *     and fire when a line matches `pattern`, or when the command exits
 *     (whichever comes first). `pattern` is optional — omit it to watch
 *     only for exit.
 *   - `file`: watch a file, directory, or glob and fire on the first
 *     create/modify event.
 *
 * Every monitor is one-shot (the first fire — match, exit, or timeout —
 * delivers exactly one notification and closes the monitor) and bounded
 * by `timeout` seconds (default 1h, max 24h). Monitors do not survive a
 * session restart: on resume, still-active monitors show up as `lost`
 * in MonitorList.
 *
 * The tool itself is pure validation + bookkeeping; watching, firing,
 * and persistence live in `MonitorManager` (`agent/monitor/manager.ts`).
 */

import { z } from 'zod';

import {
  compileMonitorPattern,
  DEFAULT_MONITOR_TIMEOUT_S,
  MAX_MONITOR_TIMEOUT_S,
  MAX_MONITORS_PER_AGENT,
  type MonitorCreateSpec,
  type MonitorManager,
  type MonitorRecord,
} from '../../agent/monitor';
import type { BuiltinTool } from '../../agent/tool';
import type { ToolExecution } from '../../loop/types';

import { toInputJsonSchema } from '../support/input-schema';
import { literalRulePattern } from '../support/rule-match';
import MONITOR_CREATE_DESCRIPTION from './monitor-create.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

const commonFields = {
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_MONITOR_TIMEOUT_S)
    .optional()
    .default(DEFAULT_MONITOR_TIMEOUT_S)
    .describe(
      `Seconds before the monitor fires a timeout notification and closes. Default ${String(DEFAULT_MONITOR_TIMEOUT_S)} (1h), max ${String(MAX_MONITOR_TIMEOUT_S)} (24h).`,
    ),
  description: z
    .string()
    .max(200)
    .optional()
    .describe('Short human-readable note echoed back in the notification, e.g. what you are waiting for.'),
};

export const MonitorCreateInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task_output'),
    task_id: z
      .string()
      .describe('The background task id (from Bash run_in_background or TaskList) whose stdout/stderr to watch.'),
    pattern: z
      .string()
      .min(1)
      .describe('JavaScript regex matched against each output line (case-sensitive, no flags). Do not rely on multi-line anchors — matching is line by line.'),
    ...commonFields,
  }),
  z.object({
    type: z.literal('command'),
    command: z
      .string()
      .min(1)
      .describe('Shell command to run and watch, e.g. "tail -f /var/log/app.log". Long-running commands are expected; the monitor owns the process and kills it after the first match.'),
    pattern: z
      .string()
      .min(1)
      .optional()
      .describe('JavaScript regex matched against each output line. Omit to watch only for command exit.'),
    ...commonFields,
  }),
  z.object({
    type: z.literal('file'),
    path: z
      .string()
      .min(1)
      .describe('File, directory (watched recursively), or glob pattern (e.g. "dist/**/*.js") to watch. Relative to the current working directory.'),
    events: z
      .array(z.enum(['created', 'modified']))
      .optional()
      .describe('Which events fire the monitor. Default: both created and modified.'),
    pattern: z
      .string()
      .min(1)
      .optional()
      .describe('JavaScript regex matched against the changed file path — only matching changes fire the monitor. Omit to fire on every change under path.'),
    ...commonFields,
  }),
]);

export type MonitorCreateInput = z.infer<typeof MonitorCreateInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class MonitorCreateTool implements BuiltinTool<MonitorCreateInput> {
  readonly name = 'MonitorCreate' as const;
  readonly description = MONITOR_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorCreateInputSchema);

  constructor(private readonly manager: MonitorManager) {}

  resolveExecution(args: MonitorCreateInput): ToolExecution {
    // Regex validity is a user error — surface the engine's message
    // verbatim, naming the offending pattern.
    const pattern = args.pattern;
    if (pattern !== undefined) {
      try {
        compileMonitorPattern(pattern);
      } catch (error) {
        return {
          isError: true,
          output: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (this.manager.activeCount() >= MAX_MONITORS_PER_AGENT) {
      return {
        isError: true,
        output: `Monitor cap reached (max ${String(MAX_MONITORS_PER_AGENT)} active monitors per agent). Cancel one with MonitorCancel first.`,
      };
    }

    return {
      description: describeArgs(args),
      // Scope `session` approval to this exact payload, matching the
      // CronCreate convention — one approval must not blanket-authorize
      // arbitrary future watchers.
      approvalRule: literalRulePattern(this.name, JSON.stringify(args)),
      execute: async () => {
        // Re-check the cap against the live manager so concurrent
        // MonitorCreate calls cannot collectively breach it after both
        // passed the prepare-time check.
        if (this.manager.activeCount() >= MAX_MONITORS_PER_AGENT) {
          return {
            isError: true,
            output: `Monitor cap reached (max ${String(MAX_MONITORS_PER_AGENT)} active monitors per agent). Cancel one with MonitorCancel first.`,
          };
        }
        try {
          const record = await this.manager.create(toSpec(args));
          return {
            output: formatOutput(record),
            isError: false,
            message: `Created monitor ${record.id}`,
          };
        } catch (error) {
          return {
            isError: true,
            output: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }
}

function toSpec(args: MonitorCreateInput): MonitorCreateSpec {
  const base = { timeoutS: args.timeout, description: args.description };
  switch (args.type) {
    case 'task_output':
      return { ...base, type: 'task_output', taskId: args.task_id, pattern: args.pattern };
    case 'command':
      return { ...base, type: 'command', command: args.command, pattern: args.pattern };
    case 'file':
      return { ...base, type: 'file', path: args.path, events: args.events, pattern: args.pattern };
  }
}

function describeArgs(args: MonitorCreateInput): string {
  switch (args.type) {
    case 'task_output':
      return `Watching task ${args.task_id} for /${args.pattern}/`;
    case 'command':
      return `Watching command: ${args.command.slice(0, 60)}`;
    case 'file':
      return args.pattern === undefined
        ? `Watching path ${args.path}`
        : `Watching path ${args.path} for /${args.pattern}/`;
  }
}

function formatOutput(record: MonitorRecord): string {
  const lines = [
    `id: ${record.id}`,
    `type: ${record.type}`,
    `status: ${record.status}`,
    `timeoutS: ${String(record.timeoutS)}`,
  ];
  if (record.taskId !== undefined) lines.push(`taskId: ${record.taskId}`);
  if (record.pattern !== undefined) lines.push(`pattern: /${record.pattern}/`);
  if (record.command !== undefined) lines.push(`command: ${record.command}`);
  if (record.path !== undefined) lines.push(`path: ${record.path}`);
  lines.push('One-shot: the monitor closes after the first match, exit, or timeout.');
  return lines.join('\n');
}
