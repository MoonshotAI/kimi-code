/**
 * CronDeleteTool — cancel a scheduled cron job by id.
 *
 * The tool's job is intentionally narrow: validate the id shape, ask the
 * session store to drop the entry, and report whether anything was
 * actually removed. The scheduler picks up the deletion on its next
 * `tick()` automatically because `source: () => store.list()` is
 * re-read every pass — there is no separate "unsubscribe" handshake to
 * keep in sync.
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
 * Why the manager is not consulted for telemetry on the not-found
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

import type { BuiltinTool } from '../../agent/tool';
import type { CronManager } from '../../agent/cron';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import CRON_DELETE_DESCRIPTION from './cron-delete.md?raw';

// ── Constants ────────────────────────────────────────────────────────

/**
 * Same id shape used by `SessionCronStore` and the on-disk persistence
 * layer. We re-check here so a malformed id never reaches the store —
 * the regex is the single source of truth for the on-the-wire id
 * format and an early reject keeps the error message close to the
 * user's input.
 */
const ID_PATTERN = /^[0-9a-f]{8}$/;

// ── Input schema ─────────────────────────────────────────────────────

export const CronDeleteInputSchema = z.object({
  id: z
    .string()
    .describe('The 8-hex cron job id returned by CronCreate / CronList.'),
});
export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class CronDeleteTool implements BuiltinTool<CronDeleteInput> {
  readonly name = 'CronDelete' as const;
  readonly description = CRON_DELETE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronDeleteInputSchema,
  );

  constructor(private readonly manager: CronManager) {}

  resolveExecution(args: CronDeleteInput): ToolExecution {
    // Format check up front. The store would reject the lookup anyway,
    // but the message is more actionable when it names the constraint
    // ("8 lowercase hex characters") rather than a generic "not found".
    if (!ID_PATTERN.test(args.id)) {
      return {
        isError: true,
        output: `Invalid cron job id ${JSON.stringify(
          args.id,
        )} — must be 8 lowercase hex characters.`,
      };
    }

    return {
      description: `Deleting cron ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        const removed = this.manager.removeTasks([args.id]);
        if (removed.length === 0) {
          // Not found is reported as an error so the model can correct
          // itself — see the module header for the rationale. We
          // deliberately do NOT emit `cron_deleted` here; the metric
          // tracks real state changes.
          return {
            isError: true,
            output: `No cron job with id ${args.id}.`,
          };
        }

        // Telemetry goes through the manager so the tool stays out of
        // `manager.agent.telemetry` — symmetric with `CronCreate`'s use
        // of `emitScheduled`.
        this.manager.emitDeleted(args.id);

        return {
          output: `Deleted cron job ${args.id}.`,
          isError: false,
        };
      },
    };
  }
}
