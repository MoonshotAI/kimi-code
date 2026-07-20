/**
 * CronDeleteTool — cancel a scheduled cron job by id.
 *
 * The tool's job is intentionally narrow: validate the id shape, ask the
 * service to drop the entry, and report whether anything was actually
 * removed. The scheduler picks up the deletion on its next `tick()`
 * automatically because the task set is re-read every pass — there is no
 * separate "unsubscribe" handshake to keep in sync.
 *
 * Why "not found" is reported as an error:
 *
 *   - The model uses the result string to decide whether to follow up
 *     (e.g. confirm to the user, retry, or move on). Returning a
 *     success-shaped message for a no-op would silently teach the model
 *     that CronDelete is idempotent against missing ids, which it is
 *     not — the next `CronList` would still show whatever id the model
 *     thought it deleted. Surfacing `isError: true` lets the model
 *     correct itself (typically by calling `CronList` again).
 *
 * Why the service is not consulted for telemetry on the not-found
 * branch:
 *
 *   - `cron_deleted` records an actual state change. Emitting it on a
 *     miss would inflate the metric and break parity with `cron_create`
 *     (which never fires on a rejected schedule). The branch is fully
 *     observable through tool-call telemetry already.
 *
 * Refresh-cron pattern this tool participates in:
 *
 *   When `CronList` (or a fired job's origin) reports `stale: true`, the
 *   documented "refresh" flow is `CronDelete(id)` followed by a fresh
 *   `CronCreate` with the same cron + prompt. That resets `createdAt`,
 *   clears the stale flag, and rejoins the herd-avoidance jitter draw
 *   with a new task id. The doc string spells this out so the model can
 *   reach for it without prompting from a system message.
 */

import { z } from 'zod';

import type { ExecutableTool as BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import CRON_DELETE_DESCRIPTION from './cron-delete.md?raw';


const ID_PATTERN = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;


export const CronDeleteInputSchema = z.object({
  id: z
    .string()
    .describe('The cron job id (ULID) returned by CronCreate / CronList.'),
});
export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;


export class CronDeleteTool implements BuiltinTool<CronDeleteInput> {
  readonly name = 'CronDelete' as const;
  readonly description = CRON_DELETE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronDeleteInputSchema,
  );

  constructor(@ISessionCronService private readonly cron: ISessionCronService) {}

  resolveExecution(args: CronDeleteInput): ToolExecution {
    if (!ID_PATTERN.test(args.id)) {
      return {
        isError: true,
        output: `Invalid cron job id ${JSON.stringify(
          args.id,
        )} — must be a ULID.`,
      };
    }

    return {
      description: `Deleting cron ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        const removed = this.cron.removeTasks([args.id]);
        if (removed.length === 0) {
          return {
            isError: true,
            output: `No cron job with id ${args.id}.`,
          };
        }

        this.cron.emitDeleted(args.id);

        return {
          output: `Deleted cron job ${args.id}.`,
          isError: false,
        };
      },
    };
  }
}
