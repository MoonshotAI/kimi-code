/**
 * `agentFs` domain barrel — re-exports the agent-filesystem contract
 * (`agentFs`) and its scoped service (`agentFsService`), the wire-shaped fs
 * service (`fs`, `fsService`), and the fs error codes (`errors`). Importing
 * this barrel registers the `ISessionAgentFileSystem` and `ISessionFsService` bindings into
 * the scope registry.
 */

export * from './agentFs';
export * from './agentFsService';
export * from './errors';
export * from './fs';
export * from './fsService';
export * from './gitContext';
export * from './rgLocator';
export * from './runRg';
