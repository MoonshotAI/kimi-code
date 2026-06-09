/**
 * `IEnvironmentService` — canonical source for resolved filesystem paths
 * (home directory, config file, etc.) used by the daemon and in-process
 * services.
 *
 * VSCode-style: injected via `@IEnvironmentService` rather than passed as
 * a static options prefix. This eliminates the "options bag as first ctor
 * arg" pattern in services that only need path resolution.
 */

import { createDecorator } from '@moonshot-ai/agent-core';

export interface IEnvironmentService {
  readonly _serviceBrand: undefined;
  /** Resolved kimi home directory (e.g. `~/.kimi-code`). */
  readonly homeDir: string;
  /** Resolved absolute path to `config.toml`. */
  readonly configPath: string;
}

export const IEnvironmentService = createDecorator<IEnvironmentService>(
  'environmentService',
);
