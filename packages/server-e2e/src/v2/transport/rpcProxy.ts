/**
 * Resource proxy factory for the `/api/v2` SDK.
 *
 * A resource (e.g. `sessions`, `prompts`) is a set of actions declared in a
 * manifest. `makeResource` returns a Proxy that turns any declared action
 * into a `POST <resource>:<action>` call. The return type is derived from the
 * manifest so every action is reachable with autocomplete; a `Precise` map
 * can override individual actions with exact wire types.
 *
 *   type Sessions = ResourceShape<typeof CORE.sessions, SessionsPrecise>;
 *   const sessions = makeResource(rpc, 'core', {}, 'sessions', CORE.sessions);
 *   await sessions.list({ page_size: 20 }); // typed via SessionsPrecise.list
 */
import type { HttpRpc, ScopeKind, ScopeParams } from './http.js';

/** Per-action metadata in a resource manifest. `readonly` actions allow GET. */
export interface ActionMeta {
  readonly readonly?: boolean;
}

/** A loose resource method — used when no precise override is provided. */
export type AnyMethod = (arg?: unknown) => Promise<unknown>;

/**
 * Derive the typed shape of a resource from its manifest + precise overrides.
 * Every manifest action becomes a method; actions present in `Precise` keep
 * their exact signature, the rest fall back to {@link AnyMethod}.
 *
 * `Precise` is keyed by action name (a typo in a key fails the constraint) but
 * its values are unconstrained (`unknown`), so a precise method never has to be
 * assignable to {@link AnyMethod}. Precise methods are rebuilt with an optional
 * arg to match the wire (every action body is optional).
 */
export type ResourceShape<
  Actions extends Record<string, ActionMeta>,
  Precise extends Partial<Record<keyof Actions, unknown>> = Record<never, never>,
> = {
  [A in keyof Actions]: A extends keyof Precise
    ? Precise[A] extends (arg?: infer P) => Promise<infer R>
      ? (arg?: P) => Promise<R>
      : AnyMethod
    : AnyMethod;
};

/** Build a resource proxy bound to a scope + resource name. */
export function makeResource<
  Actions extends Record<string, ActionMeta>,
  Precise extends Partial<Record<keyof Actions, unknown>> = Record<never, never>,
>(
  rpc: HttpRpc,
  scope: ScopeKind,
  params: ScopeParams,
  resource: string,
  actions: Actions,
): ResourceShape<Actions, Precise> {
  return new Proxy({} as ResourceShape<Actions, Precise>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!Object.prototype.hasOwnProperty.call(actions, prop)) return undefined;
      return (arg?: unknown) => rpc.call(scope, params, `${resource}:${prop}`, arg);
    },
  });
}

/**
 * Untyped escape hatch — a resource proxy that accepts ANY action name and
 * forwards it as `<resource>:<action>`. Used by `client.core<T>(resource)`,
 * `session.service<T>(resource)`, and `agent.service<T>(resource)` for actions
 * that are not (yet) in the manifest.
 */
export type DynamicResource = Record<string, AnyMethod>;

export function makeDynamicResource(
  rpc: HttpRpc,
  scope: ScopeKind,
  params: ScopeParams,
  resource: string,
): DynamicResource {
  return new Proxy({} as DynamicResource, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return (arg?: unknown) => rpc.call(scope, params, `${resource}:${prop}`, arg);
    },
  });
}
