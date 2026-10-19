import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { collection } from '#/_base/di/collection';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, overrideScopedService, registerScopedService } from '#/_base/di/scope';
import type {
  AgentTool,
  ToolDisclosure,
  ToolSource,
} from '#/tool/toolContract';
import type { RuntimeCapability } from '#/runtime/runtime';

export type AnyAgentTool = AgentTool<any>;

export type AgentToolCtor<T extends AnyAgentTool = AnyAgentTool> = new (...args: any[]) => T;

export interface AgentToolContributionOptions {
  readonly name: string;
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

const _agentToolContributions: AgentToolContribution[] = [];

export function registerAgentToolService<T extends AnyAgentTool>(
  id: ServiceIdentifier<T>,
  ctor: AgentToolCtor<T>,
  options: AgentToolContributionOptions,
): void {
  registerScopedService(
    LifecycleScope.Agent,
    id,
    ctor,
    ScopeActivation.OnDemand,
    options.domain ?? 'unknown',
  );
  _agentToolContributions.push({ id, ctor, options });
}

export function overrideAgentToolService<T extends AnyAgentTool>(
  id: ServiceIdentifier<T>,
  ctor: AgentToolCtor<T>,
  options: AgentToolContributionOptions,
): void {
  overrideScopedService(
    LifecycleScope.Agent,
    id,
    ctor,
    ScopeActivation.OnDemand,
    options.domain ?? 'unknown',
  );
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
