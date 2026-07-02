/**
 * `agentLifecycle` domain barrel — re-exports the agentLifecycle contract
 * (`agentLifecycle`) and its scoped service (`agentLifecycleService`), plus
 * the free helpers used by the `Agent` tool and the swarm scheduler to run a
 * child agent under a named profile (`applyProfileToAgent`,
 * `observeChildAgentTurn`). Importing this barrel registers the
 * `IAgentLifecycleService` binding into the scope registry and side-effect-
 * loads the `Agent` tool file so its `registerTool(...)` call runs.
 */

export * from './agentLifecycle';
export * from './agentLifecycleService';
export * from './applyProfileToAgent';
export * from './observeChildAgentTurn';
import './tools/agent';
