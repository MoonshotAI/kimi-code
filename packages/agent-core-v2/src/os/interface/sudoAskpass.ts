/**
 * `os/interface` domain (L1) — sudo askpass env provider contract.
 *
 * Defines `ISudoAskpassEnvProvider`, the port through which the Bash tool
 * obtains the per-spawn askpass environment (`SUDO_ASKPASS`, token, shim
 * PATH) for commands that may invoke sudo. The contract lives in the os
 * layer so `os/backends` never imports upward: the implementation is the
 * Session-scope `sudoAskpass` channel, which owns the helper scripts, the
 * unix socket, and the password-interaction bridge. `envForCommand` returns
 * `undefined` when the channel is disabled or unsupported (Windows), and
 * the caller spawns without the extra env — sudo then fails with its normal
 * no-TTY error, exactly as if the feature were off.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISudoAskpassEnvProvider {
  readonly _serviceBrand: undefined;

  envForCommand(command: string): Promise<Record<string, string> | undefined>;
}

export const ISudoAskpassEnvProvider: ServiceIdentifier<ISudoAskpassEnvProvider> =
  createDecorator<ISudoAskpassEnvProvider>('sudoAskpassEnvProvider');
