import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexTrafficStoreProvider } from '#/features/artex/store/artexTrafficStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './node_detail.md?raw';

export const NodeDetailInputSchema = z.object({
  id: z.number().int().optional(),
  node_id: z.number().int().optional(),
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
    @IArtexTrafficStoreProvider private readonly trafficProvider?: IArtexTrafficStoreProvider,
  ) {}

  resolveExecution(args: NodeDetailInput): ToolExecution {
    const resolvedId = args.id ?? args.node_id ?? 0;
    return {
      approvalRule: this.name,
      description: `Reading ARTEX node ${String(resolvedId)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: NodeDetailInput): Promise<ExecutableToolResult> {
    const nodeId = args.id ?? args.node_id;
    if (nodeId === undefined || nodeId <= 0) {
      return artexErr('id is required');
    }
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const node = await store.getNode(nodeId);
    if (node === undefined) return artexErr(`node ${String(nodeId)} does not exist`);
    const edges = await store.edges();
    const outgoing = edges.filter((edge) => edge.srcId === nodeId);
    const incoming = edges.filter((edge) => edge.dstId === nodeId);
    const yielded =
      node.kind === 'intent' ? await store.factsYielded(nodeId) : undefined;

    let findingId: number | undefined;
    let trafficCount: number | undefined;
    if (node.kind === 'finding') {
      const payloadFindingId = (node.payload as { finding_id?: unknown }).finding_id;
      findingId = typeof payloadFindingId === 'number' ? payloadFindingId : node.id;
      if (this.trafficProvider !== undefined) {
        const bindings = await this.trafficProvider
          .open(this.session.workspaceRoot)
          .findingBindings(node.id);
        trafficCount = bindings.length;
      } else {
        trafficCount = 0;
      }
    }

    return {
      output: artexJson({
        node,
        edges_out: outgoing.map((edge) => ({ rel: edge.rel, to: edge.dstId })),
        edges_in: incoming.map((edge) => ({ rel: edge.rel, from: edge.srcId })),
        facts_yielded: yielded,
        finding_id: findingId,
        traffic_count: trafficCount,
      }),
    };
  }
}
