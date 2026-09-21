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
    try {
      await this.binding.connectAndSwitchInTurn(environmentId, cwd);
    } catch (error) {
      if (error instanceof EnvironmentError) {
        return { output: error.message, isError: true };
      }
      throw error;
    }
    const workDir = cwd ?? this.session.cwd;
    return {
      output:
        `Environment switched to "${environmentId}" (working directory ${workDir}). ` +
        `Subsequent tool calls in this turn execute on "${environmentId}".`,
    };
  }

  private async declaredDefaultCwd(environmentId: string): Promise<string | undefined> {
    return this.environmentDeclarations.declaredDefaultCwd(environmentId);
  }
}
