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
import DESCRIPTION from './list_goals.md?raw';

export const ListGoalsInputSchema = z.object({});

export type ListGoalsInput = z.infer<typeof ListGoalsInputSchema>;

const PARAMETERS = toInputJsonSchema(ListGoalsInputSchema);

export const IArtexListGoalsTool: ServiceIdentifier<AgentTool<ListGoalsInput>> =
  createDecorator<AgentTool<ListGoalsInput>>('artexListGoalsTool');

export class ArtexListGoalsTool implements AgentTool<ListGoalsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_goals' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(_args: ListGoalsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing ARTEX goals',
      execute: () => this.execute(),
    };
  }

  private async execute(): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const goals = await handle.store.listByKind('goal');
    return {
      output: artexJson(
        goals.map((node) => {
          const payload = node.payload as Record<string, unknown>;
          return {
            node_id: node.id,
            state: node.state,
            summary: payload['summary'] ?? payload['text'],
          };
        }),
      ),
    };
  }
}
