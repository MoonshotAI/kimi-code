import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { EnvironmentError } from '#/environment/environmentRegistry';
import {
  CHANGE_ENVIRONMENT_TOOL_NAME,
  ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY,
  ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE,
} from '#/features/environmentTools/environmentTools';
import { IAgentPlanService } from '#/features/plan/plan';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import DESCRIPTION from './change-environment.md?raw';
import {
  ChangeEnvironmentInputSchema,
  IChangeEnvironmentTool,
  type ChangeEnvironmentInput,
} from './changeEnvironment';

export class ChangeEnvironmentTool implements IChangeEnvironmentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = CHANGE_ENVIRONMENT_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ChangeEnvironmentInputSchema);

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentEnvironmentBindingService private readonly binding: IAgentEnvironmentBindingService,
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @ISessionContext private readonly session: ISessionContext,
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @IEnvironmentDeclarationService private readonly environmentDeclarations: IEnvironmentDeclarationService,
  ) {}

  async resolveExecution(args: ChangeEnvironmentInput): Promise<ToolExecution> {
    const denied = mainAgentOnlyExecution(this.scopeContext, ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    if ((await this.planMode.status()) !== null) {
      return { isError: true, output: ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE };
    }
    const environmentId = args.id.trim();
    let cwd = args.cwd;
    if (environmentId !== LOCAL_ENVIRONMENT_ID && cwd === undefined) {
      cwd = await this.declaredDefaultCwd(environmentId);
      if (cwd === undefined) {
        return {
          isError: true,
          output: `environment "${environmentId}" has no defaultCwd in [environments]; pass the cwd parameter explicitly.`,
        };
      }
    }
    return {
      description: `Switching environment to ${environmentId}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, environmentId),
      execute: () => this.execution(environmentId, cwd),
    };
  }

  private async execution(
    environmentId: string,
    cwd: string | undefined,
  ): Promise<ExecutableToolResult> {
    const previous = this.binding.current.environmentId;
    try {
      await this.binding.connectAndSwitchAtTurnBoundary(environmentId, cwd);
    } catch (error) {
      if (error instanceof EnvironmentError) {
        return { output: error.message, isError: true };
      }
      throw error;
    }
    const workDir = cwd ?? this.session.cwd;
    const current = this.binding.current;
    if (current.environmentId === environmentId && current.cwd === cwd) {
      return {
        output:
          `Environment switched to "${environmentId}" (working directory ${workDir}). ` +
          `Subsequent tool calls in this turn execute on "${environmentId}".`,
      };
    }
    return {
      output:
        `Environment switch to "${environmentId}" scheduled (working directory ${workDir}). ` +
        `Other tool calls are still executing on "${previous}"; from the next turn, tool calls execute on "${environmentId}". ` +
        'A reminder with the new environment details is queued for the next turn. ' +
        'Finish any work that depends on the previous environment now, or end your turn.',
    };
  }

  private async declaredDefaultCwd(environmentId: string): Promise<string | undefined> {
    const workspace = this.workspaces.get(this.session.workspaceId);
    if (workspace === undefined) return undefined;
    return this.environmentDeclarations.declaredDefaultCwd(workspace.root, environmentId);
  }
}
