/**
 * `/api/v2` channel registry — the set of Services exposed over the wire.
 *
 * Replaces the per-method `actionMap` with VS Code's `registerChannel` model:
 * a Service is registered **once**, keyed by its decorator id (used as the
 * public channel name, e.g. `sessionIndex`), and from then on **all** of its
 * methods are reachable by reflection. There is no per-method allowlist, no
 * public renaming, and no aggregation across Services — the registered Service
 * *is* the public contract, shared as source with the client.
 *
 * The registry is the single exposure boundary (which Services are on the wire
 * at all); scope membership is still enforced downstream by `scope.accessor`.
 */

import {
  Disposable,
  getScopedServiceDescriptors,
  IAgentContextMemoryService,
  IAgentContextSizeService,
  IAgentGoalService,
  IAgentMcpService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentRPCService,
  IAgentSwarmService,
  IAgentTaskService,
  IAgentToolRegistryService,
  IAgentUsageService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IFaultInjectionService,
  IFlagService,
  IHostFolderBrowser,
  IOAuthService,
  IPluginService,
  IProviderService,
  ISessionActivity,
  ISessionApprovalService,
  ISessionFsService,
  ISessionIndex,
  ISessionInitService,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionQuestionService,
  ISessionWorkspaceCommandService,
  ISessionWorkspaceContext,
  IWorkspaceRegistry,
  LifecycleScope,
} from '@moonshot-ai/agent-core-v2';

import type { ScopedEntry, ServiceIdentifier } from '@moonshot-ai/agent-core-v2';

const channels = new Map<string, ServiceIdentifier<unknown>>();

/** Register one Service as a channel, named by its decorator id (`id.toString()`). */
export function registerChannel<T>(id: ServiceIdentifier<T>): void {
  channels.set(id.toString(), id as ServiceIdentifier<unknown>);
}

/** Resolve a channel name back to its `ServiceIdentifier`, or `undefined`. */
export function resolveChannel(name: string): ServiceIdentifier<unknown> | undefined {
  return channels.get(name);
}

/** Whether a channel name is registered. */
export function hasChannel(name: string): boolean {
  return channels.has(name);
}

/** All registered channel names (decorator ids), sorted — for introspection. */
export function registeredChannelNames(): readonly string[] {
  return Array.from(channels.keys()).toSorted();
}

export interface ChannelMethodDescriptor {
  readonly name: string;
  /** `method` is a callable; `property` is a getter readable with no args. */
  readonly kind: 'method' | 'property';
  /** Declared parameter count (`Function.length`) — a UI hint, not a schema. */
  readonly arity: number;
  /**
   * Declared parameter list as written in source (e.g. `title`,
   * `{ workspaceId, limit }`), parsed from `Function#toString`. Names only —
   * types are erased at runtime. Empty for getters and zero-arg methods.
   * Relies on running from source; a minified bundle would degrade the names.
   */
  readonly params: string;
}

export interface ChannelDescriptor {
  /** Decorator id / wire channel name, e.g. `sessionMetadata`. */
  readonly name: string;
  /**
   * Registration scope — the minimal scope at which the channel resolves.
   * Derived from the scoped DI registry (the `EXPOSED_SERVICES` comment
   * grouping is informational and may drift).
   */
  readonly scope: 'app' | 'session' | 'agent';
  /** Domain tag recorded at `registerScopedService`. */
  readonly domain: string;
  /** Public prototype members, sorted — events are instance properties and never appear. */
  readonly methods: readonly ChannelMethodDescriptor[];
}

const SCOPE_NAME: Record<LifecycleScope, ChannelDescriptor['scope']> = {
  [LifecycleScope.App]: 'app',
  [LifecycleScope.Session]: 'session',
  [LifecycleScope.Agent]: 'agent',
};

let entryIndex: Map<ServiceIdentifier<unknown>, ScopedEntry> | undefined;

function scopedEntryIndex(): Map<ServiceIdentifier<unknown>, ScopedEntry> {
  entryIndex ??= new Map(
    [LifecycleScope.App, LifecycleScope.Session, LifecycleScope.Agent]
      .flatMap((scope) => getScopedServiceDescriptors(scope))
      .map((entry) => [entry.id, entry] as const),
  );
  return entryIndex;
}

/**
 * Extract the declared parameter list from a function's source text
 * (`name(a, b = 1) {` → `a, b = 1`). Handles `async` method syntax and
 * nested parens/brackets in defaults; returns '' when unparseable.
 */
function extractParams(fn: (...args: never[]) => unknown): string {
  const src = fn.toString();
  const start = src.indexOf('(');
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i).trim();
    }
  }
  return '';
}

/** Enumerate public methods/getters by walking the ctor prototype chain. */
function describeMethods(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => unknown,
): readonly ChannelMethodDescriptor[] {
  const methods = new Map<string, ChannelMethodDescriptor>();
  let proto: object | null = ctor.prototype;
  // Stop at framework plumbing: `Disposable` (`dispose`, `_register`) and `Object`.
  while (proto !== null && proto !== Object.prototype && proto !== Disposable.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name.startsWith('_') || methods.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc === undefined) continue;
      if (typeof desc.get === 'function') {
        methods.set(name, { name, kind: 'property', arity: 0, params: '' });
      } else if (typeof desc.value === 'function') {
        const fn = desc.value as (...args: never[]) => unknown;
        methods.set(name, {
          name,
          kind: 'method',
          arity: fn.length,
          params: extractParams(fn),
        });
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...methods.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Describe every registered channel: name, registration scope, and public
 * methods. Served by `GET /api/v2/channels` so clients (kimi-inspect) can
 * render a dynamic service browser without handwritten method lists.
 */
export function describeChannels(): readonly ChannelDescriptor[] {
  return registeredChannelNames().map((name) => {
    const id = resolveChannel(name);
    const entry = id === undefined ? undefined : scopedEntryIndex().get(id);
    if (entry === undefined) {
      return { name, scope: 'app', domain: 'unknown', methods: [] };
    }
    return {
      name,
      scope: SCOPE_NAME[entry.scope],
      domain: entry.domain,
      methods: describeMethods(entry.descriptor.ctor),
    };
  });
}

// The exposed Services. Adding a method to any of these makes it callable over
// the wire with no further wiring; exposing a new Service is one `registerChannel`.
const EXPOSED_SERVICES: readonly ServiceIdentifier<unknown>[] = [
  // core
  ISessionIndex,
  IWorkspaceRegistry,
  IConfigService,
  IProviderService,
  IOAuthService,
  IAuthSummaryService,
  IFlagService,
  IPluginService,
  IHostFolderBrowser,
  IBootstrapService,
  // session
  ISessionMetadata,
  ISessionActivity,
  ISessionLifecycleService,
  ISessionInitService,
  ISessionApprovalService,
  ISessionQuestionService,
  ISessionInteractionService,
  ISessionWorkspaceContext,
  ISessionWorkspaceCommandService,
  ISessionFsService,
  // agent
  IAgentGoalService,
  IAgentPlanService,
  IAgentTaskService,
  IAgentUsageService,
  IAgentContextSizeService,
  IAgentSwarmService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentContextMemoryService,
  IAgentMcpService,
  IAgentToolRegistryService,
  IAgentRPCService,
  IFaultInjectionService,
];

for (const id of EXPOSED_SERVICES) {
  registerChannel(id);
}
