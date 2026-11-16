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
import { isTerminalArtexIntentState } from '#/features/artex/protocol/index';

import { ARTEX_INACTIVE_RESULT, artexErr, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './kill_work.md?raw';

export const KillWorkInputSchema = z.object({
  intent_id: z.number().int(),
  reason: z.string().optional(),
});

export type KillWorkInput = z.infer<typeof KillWorkInputSchema>;

const PARAMETERS = toInputJsonSchema(KillWorkInputSchema);

export const IArtexKillWorkTool: ServiceIdentifier<AgentTool<KillWorkInput>> =
  createDecorator<AgentTool<KillWorkInput>>('artexKillWorkTool');

export class ArtexKillWorkTool implements AgentTool<KillWorkInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'kill_work' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
  ) {}

  resolveExecution(args: KillWorkInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Stopping ARTEX intent ${String(args.intent_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: KillWorkInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const node = await handle.store.getNode(args.intent_id);
    if (node === undefined || node.kind !== 'intent') {
      return artexErr('intent_id must be an intent of this task');
    }
    if (isTerminalArtexIntentState(node.state)) {
      return artexErr(`intent ${String(args.intent_id)} is already ${node.state}`);
    }
    const reason = args.reason?.trim();
    if (reason !== undefined && reason.length > 0) {
      await handle.store.mergeNodePayload(args.intent_id, { kill_reason: reason });
    }
    await handle.store.setIntentState(args.intent_id, 'stopped');
    const aborted =
      this.orchestrator?.abortIntent(
        args.intent_id,
        reason !== undefined && reason.length > 0 ? new Error(reason) : undefined,
      ) ?? false;
    this.orchestrator?.notifyGraphChanged(handle.explorationId, 'kill_work');
    return {
      output: aborted
        ? `intent ${String(args.intent_id)} stopped and running worker aborted`
        : `intent ${String(args.intent_id)} stopped`,
    };
  }
}
