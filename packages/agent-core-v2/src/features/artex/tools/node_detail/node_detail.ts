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

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './node_detail.md?raw';

export const NodeDetailInputSchema = z.object({
  node_id: z.number().int(),
});

export type NodeDetailInput = z.infer<typeof NodeDetailInputSchema>;

const PARAMETERS = toInputJsonSchema(NodeDetailInputSchema);

export const IArtexNodeDetailTool: ServiceIdentifier<AgentTool<NodeDetailInput>> =
  createDecorator<AgentTool<NodeDetailInput>>('artexNodeDetailTool');

export class ArtexNodeDetailTool implements AgentTool<NodeDetailInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'node_detail' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: NodeDetailInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Reading ARTEX node ${String(args.node_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: NodeDetailInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const node = await store.getNode(args.node_id);
    if (node === undefined) return artexErr(`node ${String(args.node_id)} does not exist`);
    const edges = await store.edges();
    const outgoing = edges.filter((edge) => edge.srcId === args.node_id);
    const incoming = edges.filter((edge) => edge.dstId === args.node_id);
    const yielded =
      node.kind === 'intent' ? await store.factsYielded(args.node_id) : undefined;
    return {
      output: artexJson({
        node,
        edges_out: outgoing.map((edge) => ({ rel: edge.rel, to: edge.dstId })),
        edges_in: incoming.map((edge) => ({ rel: edge.rel, from: edge.srcId })),
        facts_yielded: yielded,
      }),
    };
  }
}
