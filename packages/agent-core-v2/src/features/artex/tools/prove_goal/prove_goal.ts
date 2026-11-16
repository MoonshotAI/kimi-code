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
import type { ArtexFactConfidence, ArtexFactSource } from '#/features/artex/protocol/index';
import { normalizeArtexFactSource } from '#/features/artex/protocol/index';

import {
  ARTEX_INACTIVE_RESULT,
  artexErr,
  openActiveGraph,
} from '../toolSupport';
import DESCRIPTION from './prove_goal.md?raw';

export const ProveGoalInputSchema = z.object({
  goal_id: z.number().int(),
  evidence_id: z.number().int(),
  reason: z.string().optional(),
});

export type ProveGoalInput = z.infer<typeof ProveGoalInputSchema>;

const PARAMETERS = toInputJsonSchema(ProveGoalInputSchema);

export const IArtexProveGoalTool: ServiceIdentifier<AgentTool<ProveGoalInput>> =
  createDecorator<AgentTool<ProveGoalInput>>('artexProveGoalTool');

export class ArtexProveGoalTool implements AgentTool<ProveGoalInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'prove_goal' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
  ) {}

  resolveExecution(args: ProveGoalInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Proving an ARTEX goal met',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ProveGoalInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;

    const goal = await store.getNode(args.goal_id);
    if (goal === undefined || goal.kind !== 'goal') {
      return artexErr('goal_id must be a goal node of this task');
    }
    const evidence = await store.getNode(args.evidence_id);
    if (evidence === undefined || (evidence.kind !== 'fact' && evidence.kind !== 'finding')) {
      return artexErr('evidence_id must be a fact/finding node of this task');
    }

    if (evidence.kind === 'fact') {
      const payload = evidence.payload as {
        confidence?: ArtexFactConfidence;
        source?: string;
      };
      const confidence = payload.confidence;
      if (confidence !== 'observed') {
        return artexErr(
          `prove_goal refused: fact ${String(args.evidence_id)} has confidence ${JSON.stringify(
            confidence ?? 'none',
          )}, and a fact proves a goal only when its confidence is "observed" (seen directly in tool output). Goal ${String(
            args.goal_id,
          )} stays open: prove it with a finding or with an observed fact.`,
        );
      }
      const source: ArtexFactSource = normalizeArtexFactSource(payload.source).source;
      if (source === 'target_response') {
        return artexErr(
          `prove_goal refused: fact ${String(args.evidence_id)} has source "target_response" (its content comes from the target, which could have planted it), and such a fact never proves a goal. Goal ${String(
            args.goal_id,
          )} stays open: prove it with a finding or with an observed fact from another source.`,
        );
      }
    }

    await store.link(args.evidence_id, 'proves', args.goal_id);
    await store.setNodeState(args.goal_id, 'met');

    const goals = await store.listByKind('goal');
    const allMet = goals.length > 0 && goals.every((node) => node.state === 'met');
    if (allMet) {
      await store.markExplorationAchieved(args.reason);
      this.orchestrator?.notifyGoalMet(handle.explorationId, args.reason);
      return {
        output: `goal ${String(args.goal_id)} marked met; all goals of this task are met — the task is automatically judged complete`,
      };
    }
    this.orchestrator?.notifyGraphChanged(handle.explorationId, 'prove_goal');
    return { output: `goal ${String(args.goal_id)} marked met` };
  }
}
