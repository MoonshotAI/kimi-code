/**
 * `kaos` domain barrel — re-exports the `kaos` contract and its scoped
 * services (`kaosFactory`, `sessionKaosService`, `agentKaos`). Importing this
 * barrel registers the `IKaosFactory`, `ISessionKaosService`, and `IAgentKaos`
 * bindings into the scope registry.
 */

export * from './kaos';
export * from './kaosFactory';
export * from './sessionKaosService';
export * from './agentKaos';
