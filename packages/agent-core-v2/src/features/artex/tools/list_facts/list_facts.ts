import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './list_facts.md?raw';

export const ListFactsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export type ListFactsInput = z.infer<typeof ListFactsInputSchema>;

const PARAMETERS = toInputJsonSchema(ListFactsInputSchema);

export const IArtexListFactsTool: ServiceIdentifier<AgentTool<ListFactsInput>> =
  createDecorator<AgentTool<ListFactsInput>>('artexListFactsTool');

export class ArtexListFactsTool implements AgentTool<ListFactsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_facts' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: ListFactsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing ARTEX facts',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ListFactsInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const facts = await handle.store.listByKind('fact', args.limit);
    return {
      output: artexJson(
        facts.map((node) => {
          const payload = node.payload as Record<string, unknown>;
          return {
            node_id: node.id,
            state: node.state,
            summary: payload['summary'] ?? payload['text'],
            detail: payload['detail'],
            evidence: payload['evidence'],
            confidence: payload['confidence'],
            source: payload['source'],
          };
        }),
      ),
    };
  }
}
