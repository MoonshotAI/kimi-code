import { toInputJsonSchema } from '#/tool/input-schema';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

import { IAgentFlowService } from '../../flow';

import DESCRIPTION from './abort.md?raw';
import { FlowAbortInputSchema, IFlowAbortTool, type FlowAbortInput } from './abort';

export class FlowAbortTool implements IFlowAbortTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FlowAbort' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FlowAbortInputSchema);

  constructor(@IAgentFlowService private readonly flow: IAgentFlowService) {}

  resolveExecution(args: FlowAbortInput): ToolExecution {
    return {
      description: 'Aborting the flow run',
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(rawArgs: FlowAbortInput): Promise<ExecutableToolResult> {
    const parsed = FlowAbortInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        isError: true,
        output: `Invalid FlowAbort input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      };
    }
    const args = parsed.data;
    const run = this.flow.run();
    if (!run.active) {
      return { isError: true, output: 'No active flow run.' };
    }
    const flowId = run.flowId ?? 'unknown';
    this.flow.abort(args.reason);
    return {
      isError: false,
      output: `Flow run \`${flowId}\` aborted${args.reason === undefined ? '' : `: ${args.reason}`}.`,
    };
  }
}
