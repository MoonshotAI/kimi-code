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
import DESCRIPTION from './add_hint.md?raw';

export const AddHintInputSchema = z.object({
  text: z.string(),
  asset_ids: z.array(z.number().int()).optional(),
});

export type AddHintInput = z.infer<typeof AddHintInputSchema>;

const PARAMETERS = toInputJsonSchema(AddHintInputSchema);

export const IArtexAddHintTool: ServiceIdentifier<AgentTool<AddHintInput>> =
  createDecorator<AgentTool<AddHintInput>>('artexAddHintTool');

export class ArtexAddHintTool implements AgentTool<AddHintInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'add_hint' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
  ) {}

  resolveExecution(args: AddHintInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Adding an ARTEX hint',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AddHintInput): Promise<ExecutableToolResult> {
    const text = args.text.trim();
    if (text.length === 0) return artexErr('text must not be empty');
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const id = await handle.store.addNode({
      kind: 'hint',
      payload: { text },
      priority: 5,
      state: 'active',
      origin: 'main',
      anchors: args.asset_ids,
    });
    this.orchestrator?.notifyGraphChanged(handle.explorationId, 'add_hint');
    return { output: `hint created: ${String(id)}` };
  }
}
