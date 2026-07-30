/**
 * `IEnvironmentService` — canonical source for resolved filesystem paths
 * (home directory, config file, etc.) and the host identity used by the
 * daemon and in-process services.
 *
 * VSCode-style: injected via `@IEnvironmentService` rather than passed as
 * a static options prefix. This eliminates the "options bag as first ctor
 * arg" pattern in services that only need path resolution.
 */

import { createDecorator } from '../../di';
import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

export interface IEnvironmentService {
  readonly _serviceBrand: undefined;
  /** Resolved kimi home directory (e.g. `~/.kimi-code`). */
  readonly homeDir: string;
  /** Resolved absolute path to `config.toml`. */
  readonly configPath: string;
  /**
   * Host identity handed to the managed OAuth toolkit so device-flow and
   * token-refresh requests carry `X-Msh-*` headers. Optional: v1 is a
   * library layer and "no identity, no headers" is the oauth package
   * contract; real hosts always set it. Rides on this bag because the DI
   * registry has no options channel that reaches OAuthService & co.
   */
  readonly identity?: KimiHostIdentity;
}

export const IEnvironmentService = createDecorator<IEnvironmentService>(
  'environmentService',
);
