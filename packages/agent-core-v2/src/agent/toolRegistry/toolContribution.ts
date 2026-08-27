import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { collection } from '#/_base/di/collection';
import type {
  AgentTool,
  ToolDisclosure,
  ToolSource,
} from '#/tool/toolContract';
import type { RuntimeCapability } from '#/runtime/runtime';

export type AnyAgentTool = AgentTool<any>;

export type AgentToolCtor<T extends AnyAgentTool = AnyAgentTool> = new (...args: any[]) => T;

export interface AgentToolFactoryContext {
  get<T>(id: ServiceIdentifier<T>): T;
  enabled(): boolean;
  load(names: readonly string[]): {
    readonly toLoad: readonly string[];
    readonly alreadyAvailable: readonly string[];
    readonly unknown: readonly string[];
  };
  isActive(name: string, source?: ToolSource): boolean;
  isActiveForProfile(
    profile: import('#/agent/toolPolicy/evaluate').ToolActivationPolicy,
    name: string,
    source?: ToolSource,
  ): boolean;
  contributions(): readonly AgentToolContribution[];
  resolve(name: string): import('#/tool/toolContract').ExecutableTool | undefined;
  listReferences(): readonly { readonly name: string; readonly source: ToolSource }[];
}

export interface AgentToolContributionOptions {
  readonly name: string;
  readonly create?: (context: AgentToolFactoryContext) => AnyAgentTool;
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly when?: (accessor: ServicesAccessor) => boolean;
  readonly requiredRuntimeCapabilities?: readonly RuntimeCapability[];
  readonly domain?: string;
}

export interface AgentToolContribution<T extends AnyAgentTool = AnyAgentTool> {
  readonly id: ServiceIdentifier<T>;
  readonly ctor: AgentToolCtor<T>;
  readonly options: AgentToolContributionOptions;
}

export const AgentToolContribution = collection<AgentToolContribution>('agent-tool');

export interface AgentToolProviderContribution {
  readonly agentId: string;
  readonly id: string;
  snapshot(): readonly {
    readonly tool: import('#/tool/toolContract').ExecutableTool;
    readonly source: ToolSource;
    readonly disclosure?: ToolDisclosure;
  }[];
  readonly onDidChange: (listener: () => void) => { dispose(): void };
}

export const AgentToolProviderContribution =
  collection<AgentToolProviderContribution>('agent-tool-provider');

const _agentToolContributions: AgentToolContribution[] = [];

export function registerAgentToolService<T extends AnyAgentTool>(
  id: ServiceIdentifier<T>,
  ctor: AgentToolCtor<T>,
  options: AgentToolContributionOptions,
): void {
  _agentToolContributions.push({ id, ctor, options });
}

export function overrideAgentToolService<T extends AnyAgentTool>(
  id: ServiceIdentifier<T>,
  ctor: AgentToolCtor<T>,
  options: AgentToolContributionOptions,
): void {
  const index = _agentToolContributions.findIndex((contribution) => contribution.id === id);
  if (index === -1) {
    _agentToolContributions.push({ id, ctor, options });
  } else {
    _agentToolContributions[index] = { id, ctor, options };
  }
}

export function getAgentToolContributions(): readonly AgentToolContribution[] {
  return _agentToolContributions;
}

export function _clearAgentToolContributionsForTests(): void {
  _agentToolContributions.length = 0;
}
