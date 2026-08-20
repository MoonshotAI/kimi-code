/**
 * MonitorCancelTool — cancel an active monitor by id.
 *
 * Intentionally narrow, mirroring CronDelete: validate the id shape, ask
 * the manager to tear the monitor down (file watcher closed, command
 * process stopped, timeout cleared), and report whether anything was
 * actually cancelled.
 *
 * "Not found" and "not active" are both reported as errors so the model
 * corrects itself (typically via MonitorList) instead of learning that
 * MonitorCancel is idempotent against missing ids — the same rationale
 * CronDelete documents.
 */

import { z } from 'zod';

import { MONITOR_ID_REGEX, type MonitorManager } from '../../agent/monitor';
import type { BuiltinTool } from '../../agent/tool';
import type { ToolExecution } from '../../loop/types';

import { toInputJsonSchema } from '../support/input-schema';
import MONITOR_CANCEL_DESCRIPTION from './monitor-cancel.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const MonitorCancelInputSchema = z.object({
  id: z.string().describe('The monitor id (mon-XXXXXXXX) returned by MonitorCreate / MonitorList.'),
});
export type MonitorCancelInput = z.infer<typeof MonitorCancelInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class MonitorCancelTool implements BuiltinTool<MonitorCancelInput> {
  readonly name = 'MonitorCancel' as const;
  readonly description = MONITOR_CANCEL_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorCancelInputSchema);

  constructor(private readonly manager: MonitorManager) {}

  resolveExecution(args: MonitorCancelInput): ToolExecution {
    if (!MONITOR_ID_REGEX.test(args.id)) {
      return {
        isError: true,
        output: `Invalid monitor id ${JSON.stringify(args.id)} — must look like mon-XXXXXXXX (8 lowercase base36 characters).`,
      };
    }

    return {
      description: `Cancelling monitor ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        const record = this.manager.cancel(args.id);
        if (record === undefined) {
          return { isError: true, output: `No monitor with id ${args.id}.` };
        }
        if (record.status !== 'cancelled') {
          return {
            isError: true,
            output: `Monitor ${args.id} is not active (status: ${record.status}); there is nothing to cancel.`,
          };
        }
        return { output: `Cancelled monitor ${args.id}.`, isError: false };
      },
    };
  }
}
