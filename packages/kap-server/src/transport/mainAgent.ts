/**
 * server-v2 — on-demand main-agent resolution.
 *
 * Sessions are created without a main agent; the first request that targets
 * `main` materializes it here. Both the `/api/v1` routes and the `/api/v2`
 * dispatcher resolve the main agent through {@link ensureMainAgent} so a
 * missing main agent is created instead of reported as `agent.not_found`.
 *
 * The main agent is created unbound (no Profile / Model). It becomes runnable
 * when the edge binds a Model — via the `profile:setModel` action, a legacy
 * prompt's `body.model` override, or a resumed wire log — at which point the
 * default profile is applied automatically. There is intentionally no default
 * model baked in here: a runnable agent only exists once a model is chosen.
 *
 * Both symbols are re-exports of the core `agentLifecycle` domain's bootstrap
 * helper, so main-agent bootstrap business (plugin session-start injection)
 * lives in exactly one place.
 */

export { ensureMainAgent, MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2';
