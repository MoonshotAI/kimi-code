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

import { ARTEX_INACTIVE_RESULT, artexErr, openActiveGraph } from '../toolSupport';
import { artexEnvelopedJson } from '../envelopeOutput';
import DESCRIPTION from './get_worker_output.md?raw';

export const GetWorkerOutputInputSchema = z.object({
  intent_id: z.number().int(),
});

export type GetWorkerOutputInput = z.infer<typeof GetWorkerOutputInputSchema>;

const PARAMETERS = toInputJsonSchema(GetWorkerOutputInputSchema);

export const IArtexGetWorkerOutputTool: ServiceIdentifier<AgentTool<GetWorkerOutputInput>> =
  createDecorator<AgentTool<GetWorkerOutputInput>>('artexGetWorkerOutputTool');

const LIVE_STEPS_PREVIEW = 10;

export class ArtexGetWorkerOutputTool implements AgentTool<GetWorkerOutputInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'get_worker_output' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: GetWorkerOutputInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Reading ARTEX worker output for intent ${String(args.intent_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: GetWorkerOutputInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const node = await store.getNode(args.intent_id);
    if (node === undefined || node.kind !== 'intent') {
      return artexErr(`intent_id ${String(args.intent_id)} does not belong to this exploration`);
    }
    const payload = node.payload;
    const storedOutput =
      typeof payload['worker_output'] === 'string' ? payload['worker_output'] : undefined;

    const activities = (await store.readActivityByNode(args.intent_id)).filter(
      (entry) => entry.kind !== 'thinking' && entry.kind !== 'usage',
    );
    const reversed = activities.toReversed();
    const resultEntry = reversed.find((entry) => entry.kind === 'result');
    const lastTextEntry = reversed.find((entry) => entry.kind === 'text');
    const liveSteps = activities.slice(-LIVE_STEPS_PREVIEW).map((entry) => ({
      step_id: entry.id,
      kind: entry.kind,
      tool: entry.tool,
      is_error: entry.isError,
      summary: entry.summary,
      at: entry.at,
    }));

    const finalText =
      storedOutput !== undefined && storedOutput.length > 0
        ? storedOutput
        : (resultEntry?.text ?? resultEntry?.summary ?? lastTextEntry?.text ?? lastTextEntry?.summary);

    if ((finalText === undefined || finalText === '') && liveSteps.length === 0) {
      return { output: '(this work has no output yet)' };
    }

    return {
      output: artexEnvelopedJson('worker_output', {
        intent_id: args.intent_id,
        state: node.state,
        final_text: finalText ?? '',
        live_steps: liveSteps,
        terminal_reason: payload['terminal_reason'],
        worker_agent_id: payload['worker_agent_id'] ?? node.owner,
      }),
    };
  }
}
