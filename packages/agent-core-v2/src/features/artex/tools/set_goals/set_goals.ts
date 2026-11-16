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

const GoalObjectSchema = z.object({
  text: z.string(),
  category: z.string().optional(),
  vulnclass: z.string().optional(),
});

export const SetGoalsInputSchema = z.object({
  goals: z.array(z.union([z.string(), GoalObjectSchema])).optional(),
  goal: z.string().optional(),
  text: z.string().optional(),
  category: z.string().optional(),
  vulnclass: z.string().optional(),
});

export type SetGoalsInput = z.infer<typeof SetGoalsInputSchema>;

const PARAMETERS = toInputJsonSchema(SetGoalsInputSchema);

export const IArtexSetGoalsTool: ServiceIdentifier<AgentTool<SetGoalsInput>> =
  createDecorator<AgentTool<SetGoalsInput>>('artexSetGoalsTool');

interface NormalizedGoal {
  readonly text: string;
  readonly category?: string;
}

function normalizeGoals(args: SetGoalsInput): NormalizedGoal[] {
  const rawItems: readonly (string | z.infer<typeof GoalObjectSchema>)[] =
    args.goals !== undefined && args.goals.length > 0
      ? args.goals
      : args.goal !== undefined || args.text !== undefined
        ? [
            {
              text: args.goal ?? args.text ?? '',
              category: args.category,
              vulnclass: args.vulnclass,
            },
          ]
        : [];
  const out: NormalizedGoal[] = [];
  for (const item of rawItems) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text.length > 0) out.push({ text });
      continue;
    }
    const text = item.text.trim();
    if (text.length === 0) continue;
    const category = (item.category ?? item.vulnclass ?? '').trim() || undefined;
    out.push({ text, category });
  }
  return out;
}

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
    const items = normalizeGoals(args);
    if (items.length === 0) return artexErr('provide at least one goal statement');
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const originId = (await handle.store.listByKind('fact')).find((n) => n.state === 'origin')?.id;
    const ids: number[] = [];
    for (const item of items) {
      const payload: Record<string, unknown> = { text: item.text, summary: item.text };
      if (item.category !== undefined) payload['category'] = item.category;
      const id = await handle.store.addGoal(payload, 'main');
      if (originId !== undefined) await handle.store.link(originId, 'spawns', id);
      ids.push(id);
    }
    await handle.store.reopenExploration();
    this.orchestrator?.notifyGraphChanged(handle.explorationId, 'set_goals');
    return { output: artexJson({ ids }) };
  }
}
