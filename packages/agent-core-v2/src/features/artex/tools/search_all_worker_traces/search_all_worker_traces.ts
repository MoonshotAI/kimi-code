import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
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
import DESCRIPTION from './search_all_worker_traces.md?raw';

export const SearchAllWorkerTracesInputSchema = z.object({
  q: z.string(),
  limit: z.number().int().optional(),
});

export type SearchAllWorkerTracesInput = z.infer<typeof SearchAllWorkerTracesInputSchema>;

const PARAMETERS = toInputJsonSchema(SearchAllWorkerTracesInputSchema);
const DEFAULT_SEARCH_LIMIT = 100;
const SUMMARY_MAX_CHARS = 100;

export const IArtexSearchAllWorkerTracesTool: ServiceIdentifier<
  AgentTool<SearchAllWorkerTracesInput>
> = createDecorator<AgentTool<SearchAllWorkerTracesInput>>('artexSearchAllWorkerTracesTool');

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

export class ArtexSearchAllWorkerTracesTool implements AgentTool<SearchAllWorkerTracesInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'search_all_worker_traces' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IAgentScopeContext private readonly scopeContext?: IAgentScopeContext,
  ) {}

  resolveExecution(args: SearchAllWorkerTracesInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Searching ARTEX worker traces for "${args.q}"`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: SearchAllWorkerTracesInput): Promise<ExecutableToolResult> {
    const query = args.q.trim();
    if (query.length === 0) return artexErr('q is required');
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;

    const ownIntentRaw = this.scopeContext?.meta?.labels?.['artexIntentId'];
    const ownIntentId = ownIntentRaw !== undefined ? Number(ownIntentRaw) : undefined;
    const limit = args.limit !== undefined && args.limit > 0 ? args.limit : DEFAULT_SEARCH_LIMIT;
    const queryLower = query.toLowerCase();

    const entries = await handle.store.readActivity();
    const hits: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (entry.kind === 'thinking' || entry.kind === 'usage') continue;
      if (entry.nodeId === undefined || entry.nodeId <= 0) continue;
      if (ownIntentId !== undefined && entry.nodeId === ownIntentId) continue;
      if (!matchesQuery(entry, queryLower)) continue;
      hits.push({
        intent_id: entry.nodeId,
        step_id: entry.id,
        worker: entry.actor,
        kind: entry.kind,
        tool: entry.tool,
        is_error: entry.isError,
        summary: clipSummary(entry),
      });
      if (hits.length >= limit) break;
    }

    return {
      output: artexJson({
        query,
        hits,
      }),
    };
  }
}
