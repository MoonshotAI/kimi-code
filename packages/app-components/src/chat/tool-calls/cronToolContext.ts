import type { ComputedRef, InjectionKey } from 'vue';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import { normalizeToolName, parseCronCreateResult, parseCronDeleteResult, parseCronListResult, type CronJobFields } from '@moonshot-ai/app-core/lib';

export const CronToolContextKey: InjectionKey<ComputedRef<ReadonlyMap<string, CronJobFields>>> = Symbol('CronToolContext');

export function cronToolContexts(turns: readonly ChatTurn[]): ReadonlyMap<string, CronJobFields> {
  const jobs = new Map<string, CronJobFields>();
  const contexts = new Map<string, CronJobFields>();
  for (const turn of turns) {
    const tools: ToolCall[] = turn.blocks?.flatMap((block) => block.kind === 'tool' ? [block.tool] : []) ?? turn.tools ?? [];
    for (const tool of tools) {
      const kind = normalizeToolName(tool.name);
      if (tool.status !== 'ok') continue;
      if (kind === 'croncreate') {
        const fields = parseCronCreateResult(tool.output);
        if (!fields?.id) continue;
        let prompt: string | undefined;
        try {
          const arg: unknown = JSON.parse(tool.arg);
          if (typeof arg === 'object' && arg !== null && 'prompt' in arg && typeof arg.prompt === 'string') prompt = arg.prompt;
        } catch {}
        jobs.set(fields.id, { ...fields, prompt });
      } else if (kind === 'cronlist') {
        for (const fields of parseCronListResult(tool.output)?.jobs ?? []) {
          if (!fields.id) continue;
          let prompt = fields.prompt;
          if (prompt !== undefined) {
            try {
              const value: unknown = JSON.parse(prompt);
              if (typeof value === 'string') prompt = value;
            } catch {}
          }
          jobs.set(fields.id, { ...jobs.get(fields.id), ...fields, prompt });
        }
      } else if (kind === 'crondelete') {
        const deleted = parseCronDeleteResult(tool.output);
        if (!deleted?.id) continue;
        const fields = jobs.get(deleted.id);
        if (fields) contexts.set(tool.id, { ...fields, nextFireAt: undefined });
      }
    }
  }
  return contexts;
}
