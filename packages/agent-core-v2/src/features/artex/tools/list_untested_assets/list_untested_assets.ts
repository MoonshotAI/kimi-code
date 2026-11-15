import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveGraph, openActiveWork } from '../toolSupport';
import DESCRIPTION from './list_untested_assets.md?raw';

export const ListUntestedAssetsInputSchema = z.object({
  type: z.string().optional(),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
});

export type ListUntestedAssetsInput = z.infer<typeof ListUntestedAssetsInputSchema>;

const PARAMETERS = toInputJsonSchema(ListUntestedAssetsInputSchema);

export const IArtexListUntestedAssetsTool: ServiceIdentifier<AgentTool<ListUntestedAssetsInput>> =
  createDecorator<AgentTool<ListUntestedAssetsInput>>('artexListUntestedAssetsTool');

export class ArtexListUntestedAssetsTool implements AgentTool<ListUntestedAssetsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_untested_assets' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
    @IArtexGraphStoreProvider private readonly graphProvider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: ListUntestedAssetsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing untested ARTEX assets',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ListUntestedAssetsInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const tested = await this.testedAssetIds();
    const page = args.page ?? 1;
    const pageSize = args.page_size ?? 10;
    const offset = (page - 1) * pageSize;
    const result = await handle.store.listUntestedAssets(
      handle.taskId,
      tested,
      args.type,
      pageSize,
      offset,
    );
    return {
      output: artexJson({
        assets: result.assets,
        total: result.total,
        page,
        page_size: pageSize,
      }),
    };
  }

  private async testedAssetIds(): Promise<number[]> {
    const graph = await openActiveGraph(this.session, this.graphProvider);
    if (graph === undefined) return [];
    const snapshot = await graph.store.load();
    const factNodeIds = new Set(
      snapshot.nodes.filter((node) => node.kind === 'fact').map((node) => node.id),
    );
    const tested = new Set<number>();
    for (const anchor of snapshot.anchors) {
      if (factNodeIds.has(anchor.nodeId)) tested.add(anchor.assetId);
    }
    return [...tested];
  }
}
