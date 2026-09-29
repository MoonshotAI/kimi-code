import { IAgentTaskService } from '#/agent/task/task';
import { TASK_EVENT_MAX_LINES_PER_WINDOW } from '#/agent/task/taskEvents';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { MONITOR_MAIN_AGENT_ONLY, mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import {
  closeProcessStdin,
  killSpawnedProcess,
  shellCommandFor,
  spawnShellCommand,
} from '#/agent/tools/os/bash/shellProcess';
import { IFlagService } from '#/app/flag/flag';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { MONITOR_FLAG_ID } from './flag';
import {
  IMonitorTool,
  MONITOR_DEFAULT_TIMEOUT_S,
  MONITOR_MAX_TIMEOUT_S,
  MONITOR_TASK_ID_PREFIX,
  type MonitorInput,
  MonitorInputSchema,
} from './monitor';
import MONITOR_DESCRIPTION from './monitor.md?raw';

export class MonitorProcessTask extends ProcessTask {
  override readonly idPrefix = MONITOR_TASK_ID_PREFIX;
  protected override readonly stdoutEvents = true;
}

export class MonitorTool implements IMonitorTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Monitor' as const;
  readonly description = renderPrompt(MONITOR_DESCRIPTION, {
    DEFAULT_TIMEOUT_S: MONITOR_DEFAULT_TIMEOUT_S,
    MAX_TIMEOUT_S: MONITOR_MAX_TIMEOUT_S,
    MAX_LINES_PER_MINUTE: TASK_EVENT_MAX_LINES_PER_WINDOW,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorInputSchema);

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: MonitorInput): ToolExecution {
    const blocked = mainAgentOnlyExecution(this.scopeContext, MONITOR_MAIN_AGENT_ONLY);
    if (blocked !== undefined) return blocked;
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      description: `Starting monitor: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: this.ctx.cwd,
        description: args.description,
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: ({ signal, toolCallId }) => this.start(args, signal, toolCallId),
    };
  }

  private async start(
    args: MonitorInput,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<ExecutableToolResult> {
    if (signal.aborted) return { isError: true, output: 'Aborted before the monitor started.' };
    if (!this.toolPolicy.isToolActive('TaskStop')) {
      return {
        isError: true,
        output: 'Monitor is not available for this agent because TaskStop is not enabled.',
      };
    }
    const description = args.description.trim();
    if (description.length === 0) {
      return { isError: true, output: 'description cannot be empty.' };
    }

    const lease = this.runtime.acquire(['process']);
    const view = new RuntimeWorkspaceView(lease.runtime, this.workspaceCtx);
    const env = lease.runtime.environment;
    const command = shellCommandFor(env, args.command);
    let proc: IHostProcess;
    try {
      proc = lease.track(await spawnShellCommand(lease.runtime.process!, env, view.workDir, command));
    } catch (error) {
      lease.dispose();
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }
    closeProcessStdin(proc);

    const timeoutS = args.persistent === true ? undefined : (args.timeout ?? MONITOR_DEFAULT_TIMEOUT_S);
    let taskId: string;
    try {
      const release = (): void => {
        lease.dispose();
      };
      taskId = this.tasks.registerTask(
        new MonitorProcessTask(proc, command, description, undefined, release, toolCallId),
        { detached: true, timeoutMs: timeoutS === undefined ? undefined : timeoutS * 1000 },
      );
    } catch (error) {
      await killSpawnedProcess(proc);
      lease.dispose();
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }

    const result: ExecutableToolResult & { readonly brief: string } = {
      isError: false,
      output: [
        `task_id: ${taskId}`,
        `pid: ${String(proc.pid)}`,
        `description: ${description}`,
        'status: running',
        timeoutS === undefined ? 'timeout: none (persistent)' : `timeout: ${String(timeoutS)}s`,
        'automatic_notification: true',
        'next_step: Each stdout line reaches you as a notification; continue with your current work instead of waiting.',
        'next_step: Stop the monitor with TaskStop when you no longer need it.',
      ].join('\n'),
      brief: `Started ${taskId}`,
    };
    return result;
  }
}

registerAgentToolService(IMonitorTool, MonitorTool, {
  name: 'Monitor',
  domain: 'agentTask',
  requiredRuntimeCapabilities: ['process'],
  when: (accessor) => accessor.get(IFlagService).enabled(MONITOR_FLAG_ID),
});
