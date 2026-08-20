/**
 * MonitorListTool — enumerate this session's monitors and their status.
 *
 * Read-only and side-effect-free. The output mirrors the
 * `key: value\n---\n` record shape used by CronList / TaskList so the
 * model sees a consistent layout across the "list scheduled work" tools.
 *
 * Status values:
 *
 *   - `active`    — watching; will fire on match / exit / timeout.
 *   - `fired`     — delivered its one notification (see `trigger`).
 *   - `cancelled` — cancelled via MonitorCancel.
 *   - `ended`     — a task_output monitor whose watched task went
 *                   terminal without a match (silent by design).
 *   - `lost`      — was active when the previous CLI process died;
 *                   loaded from disk for visibility, never re-attached.
 */

import { z } from 'zod';

import type { MonitorManager, MonitorRecord } from '../../agent/monitor';
import type { BuiltinTool } from '../../agent/tool';
import type { ToolExecution } from '../../loop/types';

import { toInputJsonSchema } from '../support/input-schema';
import MONITOR_LIST_DESCRIPTION from './monitor-list.md?raw';

/** No arguments. Strict so accidental extras are rejected, matching CronList. */
export const MonitorListInputSchema = z.object({}).strict();
export type MonitorListInput = z.infer<typeof MonitorListInputSchema>;

const MS_PER_SECOND = 1000;

export class MonitorListTool implements BuiltinTool<MonitorListInput> {
  readonly name = 'MonitorList' as const;
  readonly description = MONITOR_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorListInputSchema);

  constructor(private readonly manager: MonitorManager) {}

  resolveExecution(_args: MonitorListInput): ToolExecution {
    return {
      description: 'Listing monitors',
      approvalRule: this.name,
      execute: async () => {
        const records = this.manager.list().map((record) => this.renderRecord(record));
        const header = `monitors: ${String(records.length)}`;
        if (records.length === 0) {
          return { output: `${header}\nNo monitors registered.`, isError: false };
        }
        return { output: `${header}\n${records.join('\n---\n')}`, isError: false };
      },
    };
  }

  private renderRecord(record: MonitorRecord): string {
    const ageS = (Date.now() - record.createdAt) / MS_PER_SECOND;
    const lines = [
      `id: ${record.id}`,
      `type: ${record.type}`,
      `status: ${record.status}`,
      `timeoutS: ${String(record.timeoutS)}`,
      `ageS: ${Number.isFinite(ageS) ? ageS.toFixed(0) : '0'}`,
    ];
    if (record.description !== undefined) lines.push(`description: ${JSON.stringify(record.description)}`);
    if (record.taskId !== undefined) lines.push(`taskId: ${record.taskId}`);
    if (record.pattern !== undefined) lines.push(`pattern: /${record.pattern}/`);
    if (record.command !== undefined) lines.push(`command: ${JSON.stringify(record.command)}`);
    if (record.commandTaskId !== undefined) lines.push(`commandTaskId: ${record.commandTaskId}`);
    if (record.path !== undefined) lines.push(`path: ${JSON.stringify(record.path)}`);
    if (record.events !== undefined) lines.push(`events: ${record.events.join(',')}`);
    if (record.fire !== undefined) lines.push(`trigger: ${record.fire.trigger}`);
    return lines.join('\n');
  }
}
