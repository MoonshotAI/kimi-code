/**
 * `agent-lifecycle` domain barrel — re-exports the agent-lifecycle contract
 * (`agentLifecycle`) and its scoped service (`agentLifecycleService`).
 * Importing this barrel registers the `IAgentLifecycleService` binding into the
 * scope registry.
 */

export * from './agentLifecycle';
export * from './agentLifecycleService';
