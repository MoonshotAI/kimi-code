import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import type { ArtexActivityEntry } from '#/features/artex/store/artexGraphStore';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './get_worker_trace.md?raw';

export const GetWorkerTraceInputSchema = z.object({
  intent_id: z.number().int(),
  q: z.string().optional(),
  step_ids: z.array(z.number().int()).optional(),
  limit: z.number().int().optional(),
});

export type GetWorkerTraceInput = z.infer<typeof GetWorkerTraceInputSchema>;

const PARAMETERS = toInputJsonSchema(GetWorkerTraceInputSchema);
const MAX_STEP_IDS = 5;
const DEFAULT_TRACE_LIMIT = 100;
const SUMMARY_MAX_CHARS = 100;

export const IArtexGetWorkerTraceTool: ServiceIdentifier<AgentTool<GetWorkerTraceInput>> =
  createDecorator<AgentTool<GetWorkerTraceInput>>('artexGetWorkerTraceTool');

function clipSummary(entry: ArtexActivityEntry): string {
  const raw = (entry.summary ?? entry.text ?? '').trim();
  const newline = raw.indexOf('\n');
  const first = newline >= 0 ? raw.slice(0, newline) : raw;
  if (first.length <= SUMMARY_MAX_CHARS) return first;
  return `${first.slice(0, SUMMARY_MAX_CHARS)}…`;
}

function matchesQuery(entry: ArtexActivityEntry, queryLower: string): boolean {
  const hay = [
    entry.summary ?? '',
    entry.text ?? '',
    entry.tool ?? '',
    entry.detail !== undefined ? JSON.stringify(entry.detail) : '',
  ]
    .join('\n')
    .toLowerCase();
  return hay.includes(queryLower);
}

export class ArtexGetWorkerTraceTool implements AgentTool<GetWorkerTraceInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'get_worker_trace' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: GetWorkerTraceInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Reading worker trace for intent ${String(args.intent_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: GetWorkerTraceInput): Promise<ExecutableToolResult> {
    if (args.intent_id <= 0) return artexErr('intent_id is required');
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const intentNode = await store.getNode(args.intent_id);
    if (intentNode === undefined || intentNode.kind !== 'intent') {
      return artexErr('intent_id does not belong to this exploration');
    }

    const rawStepIds = args.step_ids ?? [];
    if (rawStepIds.length > 0) {
      const seen = new Set<number>();
      const uniqueIds: number[] = [];
      for (const id of rawStepIds) {
        if (id > 0 && !seen.has(id)) {
          seen.add(id);
          uniqueIds.push(id);
        }
      }
      const omitted = uniqueIds.slice(MAX_STEP_IDS);
      const ids = uniqueIds.slice(0, MAX_STEP_IDS);
      const acts = (await store.readActivityByIds(ids)).filter(
        (entry) =>
          entry.nodeId === args.intent_id &&
          entry.kind !== 'thinking' &&
          entry.kind !== 'usage',
      );
      const steps = acts.map((entry) => ({
        step_id: entry.id,
        kind: entry.kind,
        tool: entry.tool,
        is_error: entry.isError,
        text: entry.text,
        detail: entry.detail,
      }));
      const out: Record<string, unknown> = {
        intent_id: args.intent_id,
        steps,
        returned_step_ids: ids,
      };
      if (omitted.length > 0) {
        out['omitted_step_ids'] = omitted;
        out['notice'] =
          `At most ${String(MAX_STEP_IDS)} steps' full content per call; this call returned the first ${String(ids.length)} (${JSON.stringify(ids)}); the ${String(omitted.length)} not fetched are ${JSON.stringify(omitted)}.`;
      }
      return { output: artexJson(out) };
    }

    const limit = args.limit !== undefined && args.limit > 0 ? args.limit : DEFAULT_TRACE_LIMIT;
    const query = (args.q ?? '').trim().toLowerCase();
    const all = (await store.readActivityByNode(args.intent_id)).filter(
      (entry) => entry.kind !== 'thinking' && entry.kind !== 'usage',
    );
    const filtered = query.length > 0 ? all.filter((entry) => matchesQuery(entry, query)) : all;
    const steps = filtered.slice(0, limit).map((entry) => ({
      step_id: entry.id,
      kind: entry.kind,
      tool: entry.tool,
      is_error: entry.isError,
      summary: clipSummary(entry),
    }));
    return {
      output: artexJson({
        intent_id: args.intent_id,
        steps,
      }),
    };
  }
}
