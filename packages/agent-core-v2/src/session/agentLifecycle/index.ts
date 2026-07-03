/**
 * `agentLifecycle` domain barrel — re-exports the agentLifecycle contract
 * (`agentLifecycle`), its scoped service (`agentLifecycleService`), the
 * `runAgentTurn` prompt-origin constant (wire compatibility), the
 * `ensureMainAgent` bootstrap helper, and the requester-side run mirroring
 * helpers (`mirrorAgentRun`). Importing this barrel registers the
 * `IAgentLifecycleService` binding into the scope registry, side-effect-loads
 * the builtin agent profiles, and side-effect-loads the `Agent` tool file so its
 * `registerTool(...)` call runs — the tool is this domain's LLM-facing wrapper
 * layer, not a separate domain.
 */

import './profile';

export * from './agentLifecycle';
export * from './agentLifecycleService';
export { AGENT_RUN_PROMPT_ORIGIN } from './runAgentTurn';
export * from './mainAgent';
export * from './mirrorAgentRun';
// Deliberately last: `tools/agent` reaches `sessionSwarmService` through
// `mirrorAgentRun` → `externalHooks` → `permissionPolicy` → `agent/swarm`,
// and `sessionSwarmService` imports this barrel back. The `./agentLifecycle`
// contract (service decorator) must be evaluated before that cycle re-enters.
import './tools/agent';
