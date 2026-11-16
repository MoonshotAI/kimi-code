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

import { ARTEX_INACTIVE_RESULT, artexErr, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './steer_work.md?raw';

export const SteerWorkInputSchema = z.object({
  intent_id: z.number().int(),
  instruction: z.string(),
});

export type SteerWorkInput = z.infer<typeof SteerWorkInputSchema>;

const PARAMETERS = toInputJsonSchema(SteerWorkInputSchema);

export const IArtexSteerWorkTool: ServiceIdentifier<AgentTool<SteerWorkInput>> =
  createDecorator<AgentTool<SteerWorkInput>>('artexSteerWorkTool');

export class ArtexSteerWorkTool implements AgentTool<SteerWorkInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'steer_work' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
  ) {}

  resolveExecution(args: SteerWorkInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Steering ARTEX intent ${String(args.intent_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: SteerWorkInput): Promise<ExecutableToolResult> {
    const instruction = args.instruction.trim();
    if (instruction.length === 0) return artexErr('instruction must not be empty');
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const node = await handle.store.getNode(args.intent_id);
    if (node === undefined || node.kind !== 'intent') {
      return artexErr('intent_id must be an intent of this task');
    }
    if (node.state !== 'running' && node.state !== 'open') {
      return artexErr(
        `intent ${String(args.intent_id)} is ${node.state}; only open or running intents can be steered`,
      );
    }
    const existing = Array.isArray((node.payload as { steers?: unknown }).steers)
      ? (node.payload as { steers: unknown[] }).steers
      : [];
    await handle.store.mergeNodePayload(args.intent_id, {
      steers: [...existing, { instruction, at: new Date().toISOString() }],
    });
    this.orchestrator?.enqueueSteer(args.intent_id, instruction);
    this.orchestrator?.notifyGraphChanged(handle.explorationId, 'steer_work');
    return { output: `steer queued for intent ${String(args.intent_id)}` };
  }
}
