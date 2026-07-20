/**
 * `/api/v1/debug` channel registry — the set of Services exposed over the
 * wire, which is simply the ENTIRE scoped DI registry (no whitelist).
 *
 * In VS Code's `registerChannel` model a Service is registered once, keyed by
 * its decorator id (the public channel name), and from then on all of its
 * methods are reachable by reflection — the registered Service *is* the
 * public contract, shared as source with the client. There is no per-method
 * allowlist and no aggregation across Services.
 */

import {
  Disposable,
  getScopedServiceDescriptors,
  LifecycleScope,
} from '@moonshot-ai/agent-core-v2';

import type { ScopedEntry, ServiceIdentifier } from '@moonshot-ai/agent-core-v2';

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
   * Derived from the scoped DI registry.
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

let serviceNameIndex: Map<string, ServiceIdentifier<unknown>> | undefined;

/**
 * Wire name → identifier index over the ENTIRE scoped DI registry. The
 * decorator registry de-dupes by name, so a wire name maps to exactly one
 * identifier; a Service registered at several scopes (e.g. `logService`
 * at App + Session) resolves at its minimal scope, reachable from every
 * route form.
 */
function scopedServiceNameIndex(): Map<string, ServiceIdentifier<unknown>> {
  serviceNameIndex ??= (() => {
    const map = new Map<string, ServiceIdentifier<unknown>>();
    for (const scope of [LifecycleScope.App, LifecycleScope.Session, LifecycleScope.Agent]) {
      for (const entry of getScopedServiceDescriptors(scope)) {
        const name = entry.id.toString();
        if (!map.has(name)) map.set(name, entry.id);
      }
    }
    return map;
  })();
  return serviceNameIndex;
}

/** Resolve a wire name to its `ServiceIdentifier` anywhere in the DI registry. */
export function resolveAnyScopedServiceId(name: string): ServiceIdentifier<unknown> | undefined {
  return scopedServiceNameIndex().get(name);
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
 * Describe EVERY registered scoped Service — served by
 * `GET /api/v1/debug/channels` so dev tooling (kimi-inspect) can load the
 * full protocol surface 1:1.
 */
export function describeAllChannels(): readonly ChannelDescriptor[] {
  const byName = new Map<string, ScopedEntry>();
  for (const scope of [LifecycleScope.App, LifecycleScope.Session, LifecycleScope.Agent]) {
    for (const entry of getScopedServiceDescriptors(scope)) {
      const name = entry.id.toString();
      if (!byName.has(name)) byName.set(name, entry);
    }
  }
  return [...byName.entries()]
    .map(([name, entry]) => ({
      name,
      scope: SCOPE_NAME[entry.scope],
      domain: entry.domain,
      methods: describeMethods(entry.descriptor.ctor),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}
