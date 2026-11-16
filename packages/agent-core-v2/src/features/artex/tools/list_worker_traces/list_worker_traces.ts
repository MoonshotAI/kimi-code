import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import type { ArtexIntentNode } from '#/features/artex/protocol/index';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './list_worker_traces.md?raw';

export const ListWorkerTracesInputSchema = z.object({
  q: z.string().optional(),
  limit: z.number().int().optional(),
});

export type ListWorkerTracesInput = z.infer<typeof ListWorkerTracesInputSchema>;

const PARAMETERS = toInputJsonSchema(ListWorkerTracesInputSchema);
const DEFAULT_LIMIT = 50;

export const IArtexListWorkerTracesTool: ServiceIdentifier<AgentTool<ListWorkerTracesInput>> =
  createDecorator<AgentTool<ListWorkerTracesInput>>('artexListWorkerTracesTool');

function intentSummary(node: ArtexIntentNode): string {
  const payload = node.payload as { summary?: unknown; text?: unknown };
  if (typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
    return payload.summary.trim();
  }
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return payload.text.trim();
  }
  return '';
}

export class ArtexListWorkerTracesTool implements AgentTool<ListWorkerTracesInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_worker_traces' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: ListWorkerTracesInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing ARTEX worker traces',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ListWorkerTracesInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;

    const limit = args.limit !== undefined && args.limit > 0 ? args.limit : DEFAULT_LIMIT;
    const query = (args.q ?? '').trim().toLowerCase();
    const rawIntents = await handle.store.listByKind('intent');
    const intents = rawIntents
      .filter((node): node is ArtexIntentNode => node.kind === 'intent')
      .filter((node) => {
        switch (node.state) {
          case 'running':
          case 'done':
          case 'exhausted':
          case 'blocked':
          case 'stopped':
            return true;
          case 'open':
          case 'paused':
          case 'deleted':
            return false;
          default: {
            const exhaustive: never = node.state;
            return exhaustive;
          }
        }
      })
      .toSorted((a, b) => b.id - a.id);

    const works: Record<string, unknown>[] = [];
    for (const node of intents) {
      const summary = intentSummary(node);
      if (query.length > 0 && !summary.toLowerCase().includes(query)) continue;
      works.push({
        intent_id: node.id,
        summary,
        state: node.state,
      });
      if (works.length >= limit) break;
    }

    return { output: artexJson({ works }) };
  }
}
