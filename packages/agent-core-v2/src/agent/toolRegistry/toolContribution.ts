import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { collection } from '#/_base/di/collection';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { AgentHost } from '#/agent/host/agentHost';
import type {
  AgentTool,
  ToolDisclosure,
  ToolSource,
} from '#/tool/toolContract';
import type { RuntimeCapability } from '#/runtime/runtime';

export type AnyAgentTool = AgentTool<any>;

export interface AgentToolFactoryContext {
  readonly agent: AgentContext;
  readonly host: AgentHost;
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
  readonly create: (context: AgentToolFactoryContext) => AnyAgentTool;
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly when?: (context: AgentToolFactoryContext) => boolean;
  readonly requiredRuntimeCapabilities?: readonly RuntimeCapability[];
  readonly domain?: string;
}

export interface AgentToolContribution {
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

export function registerAgentToolService(options: AgentToolContributionOptions): void {
  _agentToolContributions.push({ options });
}

export function getAgentToolContributions(): readonly AgentToolContribution[] {
  return _agentToolContributions;
}

export function _clearAgentToolContributionsForTests(): void {
  _agentToolContributions.length = 0;
}
