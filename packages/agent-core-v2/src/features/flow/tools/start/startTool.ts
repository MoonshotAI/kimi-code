import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';

import { FLOWS_PROJECT_DIR, IAgentFlowService, type FlowDefinition } from '../../flow';
import { validateFlowDefinitionText } from '../../definition';
import { userFlowDefinitionPath, userFlowsDir } from '../../flowsSkillSource';

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
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  resolveExecution(args: FlowStartInput): ToolExecution {
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [...this.workspaceCtx.additionalDirs],
    });
    const path = view.resolve(`${FLOWS_PROJECT_DIR}/${args.flow}.md`);
    return {
      accesses: [
        ...ToolAccesses.readFile(path),
        ...ToolAccesses.readFile(userFlowDefinitionPath(this.bootstrap.homeDir, args.flow)),
      ],
      description: `Starting flow ${args.flow}`,
      approvalRule: this.name,
      execute: () => this.execution(args, path, inspected.identity.generation),
    };
  }

  private async execution(
    rawArgs: FlowStartInput,
    path: string,
    generation: string,
  ): Promise<ExecutableToolResult> {
    const parsed = FlowStartInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        isError: true,
        output: `Invalid FlowStart input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      };
    }
    const args = parsed.data;
    if (this.flow.run().active) {
      return {
        isError: true,
        output:
          'A flow run is already active in this session. Finish it or call FlowAbort before starting another.',
      };
    }

    let projectText: string | undefined;
    const lease = this.runtime.acquire(['fs']);
    try {
      if (lease.runtime.identity.generation !== generation) {
        return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
      }
      try {
        projectText = await lease.runtime.fs!.readText(path);
      } catch {
        projectText = undefined;
      }
    } finally {
      lease.dispose();
    }

    const project =
      projectText === undefined
        ? undefined
        : validateFlowDefinitionText(projectText, path, args.flow);
    if (project?.definition !== undefined) {
      return this.startRun(project.definition, args);
    }

    const userPath = userFlowDefinitionPath(this.bootstrap.homeDir, args.flow);
    let userText: string | undefined;
    try {
      userText = await this.hostFs.readText(userPath);
    } catch {
      userText = undefined;
    }
    const user =
      userText === undefined
        ? undefined
        : validateFlowDefinitionText(userText, userPath, args.flow);
    if (user?.definition !== undefined) {
      return this.startRun(user.definition, args);
    }

    if (project !== undefined) return { isError: true, output: project.error! };
    if (user !== undefined) return { isError: true, output: user.error! };
    return {
      isError: true,
      output: `Could not read the flow definition at ${path} or ${userPath}. Check that the file exists under ${FLOWS_PROJECT_DIR}/ or ${userFlowsDir(this.bootstrap.homeDir)}/.`,
    };
  }

  private startRun(definition: FlowDefinition, args: FlowStartInput): ExecutableToolResult {
    if (this.flow.hasPendingActivation()) {
      return {
        isError: true,
        output:
          'A flow activation is already queued and will start when its prompt begins. Wait for it instead of calling FlowStart.',
      };
    }
    if (!this.flow.start(definition, args.task)) {
      if (this.flow.run().active) {
        return {
          isError: true,
          output:
            'A flow run became active before this call could start one. Finish it or call FlowAbort before starting another.',
        };
      }
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
