/**
 * `process` domain (L1) — ssh `IProcessBackend` stub.
 *
 * Placeholder for the remote backend; not registered into the scope registry
 * yet. A composition root that needs ssh supplies it through
 * `ScopeOptions.extra` to override the local backend.
 */

import { NotImplementedError } from '#/_base/errors';

import { type IProcess, IProcessBackend } from './process';

export class SshProcessBackend implements IProcessBackend {
  declare readonly _serviceBrand: undefined;

  spawn(
    _args: readonly string[],
    _options: { readonly cwd: string; readonly env?: Record<string, string> },
  ): Promise<IProcess> {
    throw new NotImplementedError('sshProcessBackend');
  }
}
