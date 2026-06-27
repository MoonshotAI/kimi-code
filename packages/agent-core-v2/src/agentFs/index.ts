/**
 * `agentFs` domain barrel — re-exports the agent-filesystem contract
 * (`agentFs`), its scoped service (`agentFsService`), and the backend
 * implementations (`localFileSystemBackend`, `sshFileSystemBackend`).
 * Importing this barrel registers the `IAgentFileSystem` and default local
 * `IFileSystemBackend` bindings into the scope registry.
 */

export * from './agentFs';
export * from './agentFsService';
export * from './localFileSystemBackend';
export * from './sshFileSystemBackend';
