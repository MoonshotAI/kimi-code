import { randomUUID } from 'node:crypto';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { mainAgentOnlyExecution } from '#/agent/tools/mainAgentOnly';
import { EnvironmentError } from '#/environment/environmentRegistry';
import { IEphemeralEnvironmentConnector } from '#/environment/ephemeralEnvironment';
import {
  RESERVED_ENVIRONMENT_IDS,
  type RemoteEnvironmentEntry,
} from '#/environment/remoteEnvironmentDeclaration';
import {
  CONNECT_ENVIRONMENT_TOOL_NAME,
  ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY,
  ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE,
} from '#/features/environmentTools/environmentTools';
import { IAgentPlanService } from '#/features/plan/plan';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { IEnvironmentService } from '#/app/environment/environment';

import {
  ConnectEnvironmentInputSchema,
  IConnectEnvironmentTool,
  type ConnectEnvironmentInput,
} from './connect';
import DESCRIPTION from './connect.md?raw';

const GENERATED_ID_RANDOM_LENGTH = 6;
const ENVIRONMENT_ID_MAX = 64;

export class ConnectEnvironmentTool implements IConnectEnvironmentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = CONNECT_ENVIRONMENT_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ConnectEnvironmentInputSchema);

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @IEnvironmentService private readonly environments: IEnvironmentService,
    @IEphemeralEnvironmentConnector private readonly connector: IEphemeralEnvironmentConnector,
  ) {}

  async resolveExecution(args: ConnectEnvironmentInput): Promise<ToolExecution> {
    const denied = mainAgentOnlyExecution(this.scopeContext, ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    if ((await this.planMode.status()) !== null) {
      return { isError: true, output: ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE };
    }
    const entry = toRemoteEnvironmentEntry(args);
    const requestedId = args.id?.trim();
    if (requestedId !== undefined && requestedId.length > 0) {
      const reserved = (RESERVED_ENVIRONMENT_IDS as readonly string[]).includes(requestedId);
      if (reserved) {
        return {
          isError: true,
          output: `environment id "${requestedId}" is reserved (${RESERVED_ENVIRONMENT_IDS.join(', ')})`,
        };
      }
      if (this.environments.current(requestedId) !== undefined) {
        return {
          isError: true,
          output: `environment "${requestedId}" already exists; pick another id.`,
        };
      }
    }
    const environmentId =
      requestedId !== undefined && requestedId.length > 0
        ? requestedId
        : generateEnvironmentId(args);
    return {
      description: `Connecting temporary environment ${environmentId}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, environmentId),
      execute: () => this.execution(environmentId, entry),
    };
  }

  private async execution(
    environmentId: string,
    entry: RemoteEnvironmentEntry,
  ): Promise<ExecutableToolResult> {
    const registry = this.environments;
    if (registry.current(environmentId) !== undefined) {
      return {
        output: `environment "${environmentId}" already exists; pick another id.`,
        isError: true,
      };
    }
    try {
      const { environment, initialCwd } = await this.connector.connect({
        environmentId,
        entry,
        registry,
      });
      const host = environment.host;
      if (host === undefined) {
        throw new EnvironmentError('environment.unavailable', `environment ${environmentId} host information is not available`);
      }
      const cwdHint = initialCwd === undefined ? '' : `, initial working directory ${initialCwd}`;
      const switchHint =
        initialCwd === undefined
          ? `Switch to it with change_environment(id: "${environmentId}", cwd: <working directory on the target>)`
          : `Switch to it with change_environment(id: "${environmentId}", cwd: "${initialCwd}")`;
      return {
        output:
          `Temporary environment "${environmentId}" connected: ` +
          `${host.osKind} ${host.osVersion} ${host.osArch}, shell ${host.shellName} (${host.shellPath})${cwdHint}.\n` +
          `${switchHint}, or bind a subagent to it with Agent(environment: "${environmentId}").\n` +
          'This environment is temporary: it is not written to config and vanishes when the process exits.',
      };
    } catch (error) {
      if (error instanceof EnvironmentError) {
        return { output: error.message, isError: true };
      }
      throw error;
    }
  }

}

function toRemoteEnvironmentEntry(args: ConnectEnvironmentInput): RemoteEnvironmentEntry {
  if (args.type === 'command') {
    return { command: args.command, args: args.args, env: args.env };
  }
  if (args.type === 'ssh') {
    return { type: 'ssh', host: args.host, remoteBin: args.remoteBin };
  }
  return {
    type: 'docker',
    container: args.container,
    context: args.context,
    remoteBin: args.remoteBin,
  };
}

function generateEnvironmentId(args: ConnectEnvironmentInput): string {
  const source =
    args.type === 'ssh' ? args.host : args.type === 'docker' ? args.container : args.command;
  const base = source
    .split(/[\\/]/)
    .pop()!
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  const random = randomUUID().replaceAll('-', '').slice(0, GENERATED_ID_RANDOM_LENGTH);
  const label = (base.length > 0 ? base : 'env').slice(0, ENVIRONMENT_ID_MAX - random.length - 1);
  return `${label}-${random}`;
}
