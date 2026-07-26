/**
 * `toolRegistry` domain (L3) — module-level agent-tool contribution registry.
 *
 * Tools contribute themselves at module load via
 * `registerAgentToolService(identifier, ctor, options?)` — a double registration:
 * the tool is registered as an Agent-scope DI service
 * (`registerScopedService`) and recorded in this contribution table. The DI
 * registration explicitly uses `OnDemand` scope activation, so no tool
 * constructor runs at scope creation — constructors may legitimately throw
 * when their host capability is absent (e.g. `WebSearchTool` without a
 * configured provider), and the runtime registry always holds real instances,
 * never proxies.
 * `AgentToolActivationService` (`toolActivation`, L4) consumes the table when
 * an Agent is created: for each contribution whose `when` predicate holds and
 * whose `name` the bound Profile's tool policy allows, it resolves the
 * service through the container (`accessor.get`, triggering construction) and
 * registers it into the per-agent runtime registry. The
 * declared `name` is what lets activation filter without instantiating.
 *
 * `registerAgentToolService` is deliberately not "builtin"-scoped: the same API is
 * what external contributors (plugins, SDK consumers) will use once the
 * surface is public. The tool's origin is carried by `options.source`
 * (`'builtin'` / `'user'` / `'mcp'` / …), not by the registration API.
 *
 * Tools are always Agent-scoped services (each Agent has its own tool
 * registry, and tool constructors inject Agent-scope services), so no `scope`
 * parameter is exposed. If tools at other scopes are ever needed, add it
 * optionally without breaking existing callers.
 */

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type {
  AgentTool,
  ToolDisclosure,
  ToolSource,
} from '#/tool/toolContract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentToolCtor<T extends AnyAgentTool = AnyAgentTool> = new (...args: any[]) => T;

export interface AgentToolContributionOptions {
  /** Model-facing tool name, declared so activation can filter without instantiating. */
  readonly name: string;
  readonly source?: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly when?: (accessor: ServicesAccessor) => boolean;
  readonly domain?: string;
}

export interface AgentToolContribution<T extends AnyAgentTool = AnyAgentTool> {
  readonly id: ServiceIdentifier<T>;
  readonly ctor: AgentToolCtor<T>;
  readonly options: AgentToolContributionOptions;
}

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

export function getAgentToolContributions(): readonly AgentToolContribution[] {
  return _agentToolContributions;
}

export function _clearAgentToolContributionsForTests(): void {
  _agentToolContributions.length = 0;
}
