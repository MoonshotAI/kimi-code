/**
 * `process` domain barrel — re-exports the process contract (`process`), its
 * scoped service (`processRunnerService`), and the backend implementations
 * (`localProcessBackend`, `sshProcessBackend`). Importing this barrel
 * registers the `IProcessRunner` and default local `IProcessBackend` bindings
 * into the scope registry.
 */

export * from './process';
export * from './processRunnerService';
export * from './localProcessBackend';
export * from './sshProcessBackend';
