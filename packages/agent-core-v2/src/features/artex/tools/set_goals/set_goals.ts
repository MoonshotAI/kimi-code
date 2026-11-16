import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexOrchestrator } from '#/features/artex/engine/artexOrchestrator';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './set_goals.md?raw';

export const SetGoalsInputSchema = z.object({
  goals: z.array(z.string()).optional(),
  goal: z.string().optional(),
});

export type SetGoalsInput = z.infer<typeof SetGoalsInputSchema>;

const PARAMETERS = toInputJsonSchema(SetGoalsInputSchema);

export const IArtexSetGoalsTool: ServiceIdentifier<AgentTool<SetGoalsInput>> =
  createDecorator<AgentTool<SetGoalsInput>>('artexSetGoalsTool');

export class ArtexSetGoalsTool implements AgentTool<SetGoalsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'set_goals' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
  ) {}

  resolveExecution(args: SetGoalsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Setting ARTEX goals',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: SetGoalsInput): Promise<ExecutableToolResult> {
    const statements = (args.goals ?? [])
      .concat(args.goal === undefined ? [] : [args.goal])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (statements.length === 0) return artexErr('provide at least one goal statement');
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const originId = (await handle.store.listByKind('fact')).find((n) => n.state === 'origin')?.id;
    const ids: number[] = [];
    for (const statement of statements) {
      const id = await handle.store.addGoal({ text: statement, summary: statement }, 'main');
      if (originId !== undefined) await handle.store.link(originId, 'spawns', id);
      ids.push(id);
    }
    await handle.store.reopenExploration();
    this.orchestrator?.notifyGraphChanged(handle.explorationId, 'set_goals');
    return { output: artexJson({ ids }) };
  }
}
