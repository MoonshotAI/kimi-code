import { z } from 'zod';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import type { CronTask } from '../cronTask';
import { cronToHuman, parseCronExpression } from '../internal/cron-expr';
import { formatLocalIsoWithOffset } from '../internal/format';
import { CRON_MAIN_AGENT_ONLY } from './cron-create';

import CRON_LIST_DESCRIPTION from './cron-list.md?raw';

export const CronListInputSchema = z.object({}).strict();

export type CronListInput = z.infer<typeof CronListInputSchema>;

interface CronListFace {
  readonly isStale: (task: CronTask) => boolean;
  readonly getNextFireForTask: (taskId: string) => number | null;
  readonly list: () => readonly CronTask[];
  readonly now: () => number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PROMPT_PREVIEW_BYTES = 200;

function previewPrompt(prompt: string): string {
  const buf = Buffer.from(prompt, 'utf8');
  if (buf.byteLength <= PROMPT_PREVIEW_BYTES) return prompt;
  let end = PROMPT_PREVIEW_BYTES;
  while (end > 0 && (buf[end]! & 0b1100_0000) === 0b1000_0000) end--;
  return `${buf.subarray(0, end).toString('utf8')}…(truncated)`;
}

function renderRecord(cron: CronListFace, task: CronTask, nowMs: number): string {
  const recurring = task.recurring !== false;

  const ageMs = nowMs - task.createdAt;
  const ageDays = Number.isFinite(ageMs) ? ageMs / MS_PER_DAY : 0;

  const stale = cron.isStale(task);

  let humanSchedule = task.cron;
  let nextFireAtIso = 'null';
  try {
    const parsed = parseCronExpression(task.cron);
    humanSchedule = cronToHuman(parsed);
    const nextFireMs = cron.getNextFireForTask(task.id);
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

export function createCronListTool(cron: CronListFace, agentId: string): ToolDefinition {
  return {
    name: 'CronList',
    description: CRON_LIST_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (agentId !== MAIN_AGENT_ID) {
        return { content: [{ type: 'text', text: CRON_MAIN_AGENT_ONLY }], isError: true };
      }
      const tasks = cron.list();
      const nowMs = cron.now();
      const records = tasks.map((task) => renderRecord(cron, task, nowMs));
      const header = `cron_jobs: ${String(tasks.length)}`;
      if (records.length === 0) {
        return { content: [{ type: 'text', text: `${header}\nNo cron jobs scheduled.` }] };
      }
      return { content: [{ type: 'text', text: `${header}\n${records.join('\n---\n')}` }] };
    },
  };
}
