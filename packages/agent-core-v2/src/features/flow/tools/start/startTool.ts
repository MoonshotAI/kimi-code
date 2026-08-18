import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';

import { FLOWS_PROJECT_DIR, IAgentFlowService, type FlowDefinition } from '../../flow';
import { FlowDefinitionParseError, parseFlowDefinition } from '../../definition';

import DESCRIPTION from './start.md?raw';
import { FlowStartInputSchema, IFlowStartTool, type FlowStartInput } from './start';

export class FlowStartTool implements IFlowStartTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FlowStart' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FlowStartInputSchema);

  constructor(
    @IAgentFlowService private readonly flow: IAgentFlowService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {}

  resolveExecution(args: FlowStartInput): ToolExecution {
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [...this.workspaceCtx.additionalDirs],
    });
    const path = view.resolve(`${FLOWS_PROJECT_DIR}/${args.flow}.md`);
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Starting flow ${args.flow}`,
      approvalRule: this.name,
      execute: () => this.execution(args, path, inspected.identity.generation),
    };
  }

  private async execution(
    args: FlowStartInput,
    path: string,
    generation: string,
  ): Promise<ExecutableToolResult> {
    if (this.flow.run().active) {
      return {
        isError: true,
        output:
          'A flow run is already active in this session. Finish it or call FlowAbort before starting another.',
      };
    }

    let text: string;
    const lease = this.runtime.acquire(['fs']);
    try {
      if (lease.runtime.identity.generation !== generation) {
        return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
      }
      text = await lease.runtime.fs!.readText(path);
    } catch {
      return {
        isError: true,
        output: `Could not read the flow definition at ${path}. Check that the file exists under ${FLOWS_PROJECT_DIR}/.`,
      };
    } finally {
      lease.dispose();
    }

    let definition: FlowDefinition;
    try {
      definition = parseFlowDefinition(text);
    } catch (error) {
      if (error instanceof FlowDefinitionParseError) {
        return { isError: true, output: `${error.message} (${path})` };
      }
      throw error;
    }

    if (!this.flow.start(definition, args.task)) {
      return {
        isError: true,
        output: 'Flow runs are disabled (the flow experimental flag is off), so the run was not started.',
      };
    }
    return { isError: false, output: renderBlueprint(definition, args.task) };
  }
}

function renderBlueprint(definition: FlowDefinition, task: string): string {
  const stages = definition.stages.map((stage, index) => {
    const notes = stage.notes === undefined ? '' : `\n   - Notes: ${stage.notes}`;
    return `${index + 1}. \`${stage.id}\` (gate: ${stage.gate})\n   - Objective: ${stage.objective}\n   - Completion: ${stage.completion}${notes}`;
  });
  return [
    `Flow run started: \`${definition.id}\``,
    `Task: ${task}`,
    '',
    '## Stages',
    ...stages,
    '',
    `The run is at stage \`${definition.stages[0]!.id}\`. Restate the task and this blueprint to the user, clarify any unverifiable completion criteria, then dispatch the first stage to a worker.`,
  ].join('\n');
}
