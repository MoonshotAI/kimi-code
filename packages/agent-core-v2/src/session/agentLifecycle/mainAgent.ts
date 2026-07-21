/**
 * `agentLifecycle` domain (L6) — main-agent bootstrap helper.
 *
 * The main agent is an ordinary agent whose only distinction is
 * `agentId === 'main'`; `IAgentLifecycleService` itself knows nothing about
 * it. `ensureMainAgent` is the single convenience entry point for the
 * conventional id so edge callers (session resume, legacy session/message
 * services, the server routes, the `/api/v2` dispatcher) do not repeat the
 * `create({ agentId: MAIN_AGENT_ID })` incantation — and never misspell it.
 *
 * `create` is create-or-get for explicit ids — it joins an in-flight creation
 * and returns an already-created main agent as-is — so concurrent
 * bootstrappers always receive the same, fully-bootstrapped handle (activity
 * lane `idle`). Session-level eager ignition (cron, external hooks) lives in
 * `sessionLifecycle.materializeSession`; the default permission posture is
 * applied in `bindBootstrap`.
 *
 * Not a Service: a pure composition helper over the session handle.
 */

import type { ISessionScopeHandle, IAgentScopeHandle } from '#/_base/di/scope';

import { type CreateAgentOptions, IAgentLifecycleService, MAIN_AGENT_ID } from './agentLifecycle';

/**
 * Return the session's main agent, creating it when it does not exist yet.
 */
export async function ensureMainAgent(
  session: ISessionScopeHandle,
  opts?: Omit<CreateAgentOptions, 'agentId'>,
): Promise<IAgentScopeHandle> {
  return session.accessor.get(IAgentLifecycleService).create({
    ...opts,
    agentId: MAIN_AGENT_ID,
  });
}
