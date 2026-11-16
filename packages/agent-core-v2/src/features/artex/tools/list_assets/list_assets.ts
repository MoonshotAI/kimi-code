import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import type { ArtexAssetQuery } from '#/features/artex/store/artexWorkStore';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveWork } from '../toolSupport';
import DESCRIPTION from './list_assets.md?raw';

export const ListAssetsInputSchema = z.object({
  dsl: z.string().optional(),
  text: z.string().optional(),
  type: z.string().optional(),
  id: z.number().int().optional(),
  ids: z.array(z.number().int()).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

export type ListAssetsInput = z.infer<typeof ListAssetsInputSchema>;

const PARAMETERS = toInputJsonSchema(ListAssetsInputSchema);

export const IArtexListAssetsTool: ServiceIdentifier<AgentTool<ListAssetsInput>> =
  createDecorator<AgentTool<ListAssetsInput>>('artexListAssetsTool');

export class ArtexListAssetsTool implements AgentTool<ListAssetsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_assets' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: ListAssetsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Querying ARTEX assets',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ListAssetsInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const byId = args.id !== undefined || (args.ids !== undefined && args.ids.length > 0);
    const hasDsl = args.dsl !== undefined && args.dsl.trim() !== '';
    const hasText = args.text !== undefined && args.text.trim() !== '';
    if (!byId && !hasDsl && !hasText) {
      return artexErr(
        'dsl or text must not be empty when id/ids are not passed: unconditional queries over all assets are not allowed; please provide a query condition',
      );
    }
    const query: ArtexAssetQuery = {
      id: args.id,
      ids: args.ids,
      type: args.type,
      dsl: args.dsl,
      text: args.text,
      taskId: handle.taskId,
      limit: args.limit ?? 10,
      offset: args.offset,
    };
    try {
      const assets = await handle.store.listAssets(query);
      return { output: artexJson({ count: assets.length, assets }) };
    } catch (error) {
      return artexErr(
        `DSL error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
