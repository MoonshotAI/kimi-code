import { ref, type LiveRef } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';
import {
  ENVIRONMENT_ARGUMENT,
  IAgentToolRegistryService,
  type ToolEnvironmentRoute,
  type ToolReference,
  type ToolRegistrationOptions,
} from './toolRegistry';

import './builtinToolAssemblyService';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly environmentScoped: boolean;
}

export class AgentToolRegistryService implements IAgentToolRegistryService {
  declare readonly _serviceBrand: undefined;
  private readonly tools = new Map<string, ToolEntry>();

  constructor(
    @ref(IAgentEnvironmentService) private readonly environment?: LiveRef<IAgentEnvironmentService>,
  ) {}

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? 'builtin';
    const entry: ToolEntry = {
      tool,
      source,
      disclosure: options.disclosure,
      environmentScoped: options.environmentScoped === true,
    };
    this.unregisterTool(tool.name);
    this.tools.set(tool.name, entry);

    return toDisposable(() => {
      const current = this.tools.get(tool.name);
      if (current !== entry) return;
      this.unregisterTool(tool.name);
    });
  }

  list(): readonly ToolInfo[] {
    const multipleEnvironments = (this.environment?.current?.targets().length ?? 0) >= 2;
    const environmentSchema = !multipleEnvironments
      ? undefined
      : {
          type: 'string',
          description: 'Environment id from the environment roster. Omit to use the primary environment.',
        };
    return [...this.tools.values()]
      .map(({ tool, source, disclosure, environmentScoped }) => ({
        name: tool.name,
        description: tool.description,
        parameters:
          environmentScoped && environmentSchema !== undefined && isPlainRecord(tool.parameters['properties'])
            ? {
                ...tool.parameters,
                properties: { ...tool.parameters['properties'], [ENVIRONMENT_ARGUMENT]: environmentSchema },
              }
            : tool.parameters,
        source,
        disclosure,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listReferences(): readonly ToolReference[] {
    return [...this.tools.entries()]
      .map(([name, { source }]) => ({ name, source }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }

  routeEnvironment(name: string, args: unknown): ToolEnvironmentRoute {
    if (this.tools.get(name)?.environmentScoped !== true) return { args };
    const targets = this.environment?.current?.targets() ?? [];
    if (targets.length < 2 || !isPlainRecord(args) || !Object.hasOwn(args, ENVIRONMENT_ARGUMENT)) {
      return { args, environment: targets[0] };
    }
    const { [ENVIRONMENT_ARGUMENT]: requested, ...rest } = args;
    const target = targets.find((candidate) => candidate.environmentId === requested);
    if (target === undefined) {
      const available = targets
        .map((candidate) => (candidate.primary ? `${candidate.environmentId} (primary)` : candidate.environmentId))
        .join(', ');
      return { args, error: `Unknown environment ${JSON.stringify(requested)}. Available environments: ${available}.` };
    }
    return { args: rest, environment: target };
  }

  private unregisterTool(name: string): ToolEntry | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return undefined;
    this.tools.delete(name);
    return entry;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolRegistryService,
  AgentToolRegistryService,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
