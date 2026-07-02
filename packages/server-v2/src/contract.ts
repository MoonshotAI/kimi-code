/**
 * `@moonshot-ai/server-v2/contract` — the public `/api/v2` wire contract.
 *
 * Re-exports the server-side allowlists that bind public `resource:action`
 * segments and event names to internal Services. Client SDKs import this
 * module to stay in lockstep with the server surface (e.g. drift tests that
 * assert every exposed action has a typed client method).
 *
 * Note: this module intentionally pulls in `@moonshot-ai/agent-core-v2` types
 * (the `ServiceIdentifier`s inside `actionMap`/`eventMap`). It is meant for
 * tooling and tests, not for runtime import by a wire-only client.
 */
export { actionMap, resolveAction } from './transport/actionMap';
export type { ActionTarget, ScopeKind, ServiceAction } from './transport/channel';
export { formatServiceAction, parseServiceAction } from './transport/channel';
