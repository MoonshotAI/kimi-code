/**
 * `sessionSwarm` domain barrel — re-exports the sessionSwarm contract
 * (`sessionSwarm`) and its scoped service (`sessionSwarmService`). Importing
 * this barrel registers the `ISessionSwarmService` binding into the scope
 * registry. The internal `subagentBatch` scheduler is not exported.
 */

export * from './sessionSwarm';
export * from './sessionSwarmService';
