/**
 * `sudoAskpass` domain (L7) — per-session sudo askpass channel.
 *
 * Defines the `ISessionSudoAskpassService` that lets the Bash tool run
 * `sudo` commands without a tty: for every spawned command it returns the
 * environment pointing sudo at a per-session askpass helper
 * (`SUDO_ASKPASS` + token + originating command), or `undefined` when the
 * channel is disabled (config) or unsupported (Windows). The helper
 * authenticates back to the engine over a per-session unix socket; each
 * validated connection becomes one `password` interaction the connected
 * client answers. The returned env carries the session's askpass token —
 * it identifies the channel, it is NOT the user's password. Session-scoped:
 * the socket, helper directory, and token are born lazily on first use and
 * die with the session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** Env var names injected into spawned shell commands (exact wire contract). */
export const SUDO_ASKPASS_ENV = 'SUDO_ASKPASS';
export const SUDO_ASKPASS_TOKEN_ENV = 'KIMI_SUDO_ASKPASS_TOKEN';
export const SUDO_ASKPASS_COMMAND_ENV = 'KIMI_SUDO_ASKPASS_COMMAND';

export interface ISessionSudoAskpassService {
  readonly _serviceBrand: undefined;

  /**
   * Environment for one spawned command. Lazily starts the askpass socket on
   * first use. Returns `undefined` when the channel is disabled via config or
   * the host is Windows — callers then spawn without askpass support.
   */
  envForCommand(command: string): Promise<Record<string, string> | undefined>;
}

export const ISessionSudoAskpassService: ServiceIdentifier<ISessionSudoAskpassService> =
  createDecorator<ISessionSudoAskpassService>('sessionSudoAskpassService');
