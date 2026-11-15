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
import type { ArtexIntentState } from '#/features/artex/protocol/index';

import { ARTEX_INACTIVE_RESULT, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './graph_overview.md?raw';

export const GraphOverviewInputSchema = z.object({});

export type GraphOverviewInput = z.infer<typeof GraphOverviewInputSchema>;

const PARAMETERS = toInputJsonSchema(GraphOverviewInputSchema);

export const IArtexGraphOverviewTool: ServiceIdentifier<AgentTool<GraphOverviewInput>> =
  createDecorator<AgentTool<GraphOverviewInput>>('artexGraphOverviewTool');

const FRONTIER_PREVIEW = 20;

export class ArtexGraphOverviewTool implements AgentTool<GraphOverviewInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'graph_overview' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(_args: GraphOverviewInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Reading the ARTEX graph overview',
      execute: () => this.execute(),
    };
  }

  private async execute(): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store, explorationId } = handle;
    const [stats, nodes, root, frontier] = await Promise.all([
      store.stats(),
      store.nodes(),
      store.root(),
      store.frontier(FRONTIER_PREVIEW),
    ]);

    const intentCounts: Record<ArtexIntentState, number> = {
      open: 0,
      running: 0,
      paused: 0,
      done: 0,
      blocked: 0,
      exhausted: 0,
      stopped: 0,
      deleted: 0,
    };
    for (const node of nodes) {
      if (node.kind === 'intent') intentCounts[node.state] += 1;
    }

    const goals = nodes
      .filter((node) => node.kind === 'goal')
      .map((node) => ({
        id: node.id,
        state: node.state,
        summary: (node.payload as { summary?: unknown; text?: unknown }).summary ??
          (node.payload as { text?: unknown }).text,
      }));

    return {
      output: artexJson({
        exploration_id: explorationId,
        goal: root.goal,
        scope: root.description,
        node_counts: stats,
        intents: intentCounts,
        goals,
        frontier: frontier.map((node) => ({
          id: node.id,
          priority: node.priority,
          summary: (node.payload as { summary?: unknown }).summary,
        })),
      }),
    };
  }
}
