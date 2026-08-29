import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentCron, type CronRuntime } from '#/features/cron/cronAgentRuntime';
import { cronToHuman, parseCronExpression } from '#/features/cron/internal/cron-expr';
import { type CronTask } from '#/features/cron/cronTask';
import { formatLocalIsoWithOffset } from '#/features/cron/internal/format';

import { CRON_MAIN_AGENT_ONLY, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { ICronListTool, CronListInputSchema, type CronListInput } from './cron-list';
import CRON_LIST_DESCRIPTION from './cron-list.md?raw';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PROMPT_PREVIEW_BYTES = 200;

function previewPrompt(prompt: string): string {
  const buf = Buffer.from(prompt, 'utf8');
  if (buf.byteLength <= PROMPT_PREVIEW_BYTES) return prompt;
  let end = PROMPT_PREVIEW_BYTES;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${buf.subarray(0, end).toString('utf8')}…(truncated)`;
}

export class CronListTool implements ICronListTool {
  declare readonly _serviceBrand: undefined;

  readonly name = 'CronList' as const;
  readonly description = CRON_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronListInputSchema,
  );

  constructor(
    @IAgentLifecycleService private readonly manager: IAgentLifecycleService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
  ) {}

  private get cron(): CronRuntime {
    return this.manager.resolve(this.scope.agentContext, AgentCron);
  }

  resolveExecution(_args: CronListInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scope, CRON_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    return {
      description: 'Listing scheduled cron jobs',
      approvalRule: this.name,
      execute: async () => {
        const tasks = this.cron.list();
        const nowMs = this.cron.now();
        const records = tasks.map((t) => this.renderRecord(t, nowMs));
        const header = `cron_jobs: ${String(tasks.length)}`;
        if (records.length === 0) {
          return {
            output: `${header}\nNo cron jobs scheduled.`,
            isError: false,
          };
        }
        return {
          output: `${header}\n${records.join('\n---\n')}`,
          isError: false,
        };
      },
    };
  }

  private renderRecord(task: CronTask, nowMs: number): string {
    const recurring = task.recurring !== false;

    const ageMs = nowMs - task.createdAt;
    const ageDays = Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0;

    const stale = this.cron.isStale(task);

    let humanSchedule = task.cron;
    let nextFireAtIso = 'null';
    try {
      const parsed = parseCronExpression(task.cron);
      humanSchedule = cronToHuman(parsed);
      const nextFireMs = this.cron.getNextFireForTask(task.id);
      if (nextFireMs !== null) {
        nextFireAtIso = formatLocalIsoWithOffset(nextFireMs);
      }
    } catch {
    }

    return [
      `id: ${task.id}`,
      `cron: ${task.cron}`,
      `humanSchedule: ${humanSchedule}`,
      `prompt: ${JSON.stringify(previewPrompt(task.prompt))}`,
      `nextFireAt: ${nextFireAtIso}`,
      `recurring: ${String(recurring)}`,
      `ageDays: ${ageDays.toFixed(2)}`,
      `stale: ${String(stale)}`,
    ].join('\n');
  }
}
