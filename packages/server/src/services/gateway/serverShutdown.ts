import { createDecorator } from '@moonshot-ai/agent-core';

/**
 * `IServerShutdownService` — triggers a graceful, process-terminating shutdown
 * of the running server from inside a route handler.
 *
 * Registered by `startServer` with the real `close()` + `process.exit(0)`
 * implementation; overridable via `ServerStartOptions.serviceOverrides` so
 * tests can observe the request without killing the test runner.
 */
export interface IServerShutdownService {
  readonly _serviceBrand: undefined;

  /**
   * Shut the server down and terminate the process. Implementations must be
   * idempotent (safe to call concurrently with a SIGTERM-driven shutdown).
   */
  requestShutdown(reason: string): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IServerShutdownService = createDecorator<IServerShutdownService>(
  'serverShutdownService',
);
