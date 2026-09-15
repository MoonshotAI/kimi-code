import { type ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern } from '#/tool/rule-match';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentCronService } from '#/features/cron/cronService';
import { computeNextCronRun, cronToHuman, hasFireWithinYears, parseCronExpression, type ParsedCronExpression } from '#/features/cron/internal/cron-expr';
import { formatLocalIsoWithOffset } from '#/features/cron/internal/format';

import {
  ICronCreateTool,
  CronCreateInputSchema,
  MAX_CRON_JOBS_PER_SESSION,
  MAX_PROMPT_BYTES,
  type CronCreateInput,
  type CronCreateOutput,
} from './cron-create';
import { CRON_MAIN_AGENT_ONLY, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import CRON_CREATE_DESCRIPTION from './cron-create.md?raw';

const ONE_SHOT_MAX_FUTURE_MS = 350 * 24 * 60 * 60 * 1000;

export class CronCreateTool implements ICronCreateTool {
  declare readonly _serviceBrand: undefined;

  readonly name = 'CronCreate' as const;
  readonly description = CRON_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronCreateInputSchema,
  );

  constructor(
    @IAgentCronService private readonly cron: IAgentCronService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: CronCreateInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, CRON_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    if (this.cron.isDisabled()) {
      return {
        isError: true,
        output: 'Cron scheduling is disabled (KIMI_DISABLE_CRON=1).',
      };
    }

    const normalizedCron = args.cron.trim().split(/\s+/).join(' ');

    let parsed: ParsedCronExpression;
    try {
      parsed = parseCronExpression(normalizedCron);
    } catch (err) {
      return {
        isError: true,
        output: `Invalid cron expression: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    const nowAtPrepare = this.cron.now();
    if (!hasFireWithinYears(parsed, 5, nowAtPrepare)) {
      return {
        isError: true,
        output: `Cron expression ${JSON.stringify(
          normalizedCron,
        )} has no fire within 5 years; refusing to schedule.`,
      };
    }

    if (this.cron.list().length >= MAX_CRON_JOBS_PER_SESSION) {
      return {
        isError: true,
        output: `Cron job cap reached (max ${String(
          MAX_CRON_JOBS_PER_SESSION,
        )} per session).`,
      };
    }

    const byteLen = Buffer.byteLength(args.prompt, 'utf8');
    if (byteLen > MAX_PROMPT_BYTES) {
      return {
        isError: true,
        output: `Prompt exceeds ${String(
          MAX_PROMPT_BYTES,
        )} bytes (got ${String(byteLen)}).`,
      };
    }

    const recurring = args.recurring !== false;

    if (!recurring) {
      const firstFire = computeNextCronRun(parsed, nowAtPrepare);
      if (
        firstFire !== null &&
        firstFire - nowAtPrepare > ONE_SHOT_MAX_FUTURE_MS
      ) {
        return {
          isError: true,
          output: `One-shot cron ${JSON.stringify(
            normalizedCron,
          )} would not fire until ${formatLocalIsoWithOffset(
            firstFire,
          )} (more than a year out). If you meant "today" or a near date, the pinned day/month has already passed this year — pick a future date or use wildcards.`,
        };
      }
    }

    return {
      description: recurring
        ? `Scheduling cron ${normalizedCron}`
        : `Scheduling one-shot ${normalizedCron}`,
      approvalRule: literalRulePattern(
        this.name,
        JSON.stringify({
          cron: normalizedCron,
          prompt: args.prompt,
          recurring,
        }),
      ),
      execute: async () => {
        const nowMs = this.cron.now();

        if (this.cron.list().length >= MAX_CRON_JOBS_PER_SESSION) {
          return {
            isError: true,
            output: `Cron job cap reached (max ${String(
              MAX_CRON_JOBS_PER_SESSION,
            )} per session).`,
          };
        }

        const task = this.cron.addTask({
          cron: normalizedCron,
          prompt: args.prompt,
          recurring,
        });

        const ideal = computeNextCronRun(parsed, nowMs);
        const nextFireAt =
          ideal === null ? null : this.cron.computeDisplayNextFire(task, parsed, ideal);

        const humanSchedule = cronToHuman(parsed);

        this.cron.emitScheduled(task, this.scopeContext.agentId);

        const output: CronCreateOutput = {
          id: task.id,
          cron: normalizedCron,
          humanSchedule,
          recurring,
          nextFireAt,
        };

        return {
          output: formatOutput(output),
          isError: false,
        };
      },
    };
  }
}

function formatOutput(o: CronCreateOutput): string {
  const lines = [
    `id: ${o.id}`,
    `cron: ${o.cron}`,
    `humanSchedule: ${o.humanSchedule}`,
    `recurring: ${String(o.recurring)}`,
    `nextFireAt: ${
      o.nextFireAt === null ? 'null' : formatLocalIsoWithOffset(o.nextFireAt)
    }`,
  ];
  return lines.join('\n');
}
