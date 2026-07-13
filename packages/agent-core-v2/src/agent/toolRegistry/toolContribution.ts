/**
 * `toolRegistry` domain (L3) — module-level tool contribution registry.
 *
 * Tools contribute themselves at module load via `registerTool(ctor, options?)`
 * — the same "import = register" pattern used by `registerScopedService` for
 * DI services and by `registerConfigSection` for config. `AgentToolRegistryService`
 * (Agent scope) consumes the accumulated contributions on construction: for each
 * contribution whose `when` predicate holds, it uses `IInstantiationService.createInstance`
 * to build the tool (passing any `staticArgs` before the injected DI dependencies)
 * and registers it into the per-agent runtime registry.
 *
 * `registerTool` is deliberately not "builtin"-scoped: the same API is what
 * external contributors (plugins, SDK consumers) will use once the surface is
 * public. The tool's origin is carried by `options.source` (`'builtin'` /
 * `'user'` / `'mcp'` / …), not by the registration API.
 *
 * Tools are always Agent-scoped instances (each Agent has its own tool
 * registry, and tool constructors inject Agent-scope services), so no `scope`
 * parameter is exposed. If tools at other scopes are ever needed, add it
 * optionally without breaking existing callers.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { ExecutableTool, ToolSource } from '#/tool/toolContract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExecutableTool = ExecutableTool<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolCtor<T extends AnyExecutableTool = AnyExecutableTool> = new (...args: any[]) => T;

export interface ToolContributionOptions {
  /**
   * Origin tag stored alongside the tool in the runtime registry. Defaults to
   * `'builtin'` when omitted (mirroring the current runtime `register()`
   * default). External contributors would pass `'user'`, `'plugin'`, etc.
   */
  readonly source?: ToolSource;
  /**
   * Optional per-Agent predicate. Evaluated once when the Agent's tool registry
   * is constructed; if it returns `false`, the contribution is skipped for that
   * Agent. Runs inside an `invokeFunction` so it can `.get()` any Agent-scope
   * service.
   */
  readonly when?: (accessor: ServicesAccessor) => boolean;
  /**
   * Optional supplier of leading static arguments passed to the tool
   * constructor before any DI-injected services (matching the SyncDescriptor
   * convention). Also invoked with a `ServicesAccessor`, so runtime config
   * values (`IConfigService.get(...)`) can flow through here without a
   * dedicated wrapper class.
   */
  readonly staticArgs?: (accessor: ServicesAccessor) => readonly unknown[];
}

export interface ToolContribution<T extends AnyExecutableTool = AnyExecutableTool> {
  readonly ctor: ToolCtor<T>;
  readonly options: ToolContributionOptions;
}

const _toolContributions: ToolContribution[] = [];

export function registerTool<T extends AnyExecutableTool>(
  ctor: ToolCtor<T>,
  options: ToolContributionOptions = {},
): void {
  _toolContributions.push({ ctor: ctor as ToolCtor, options });
}

export function getToolContributions(): readonly ToolContribution[] {
  return _toolContributions;
}

/**
 * Test hook. Clears the module-level contribution list so a test can register
 * a bounded set (mirrors `_clearScopedRegistryForTests`). Not for production
 * code — the tool table is meant to accumulate over the process lifetime.
 */
export function _clearToolContributionsForTests(): void {
  _toolContributions.length = 0;
}
