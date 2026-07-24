/**
 * `sudoAskpass` domain (L7) — per-session sudo askpass channel.
 *
 * Implements the os-layer `ISudoAskpassEnvProvider` port
 * (`#/os/interface/sudoAskpass`) that lets the Bash tool run `sudo`
 * commands without a tty: for every spawned command it returns the
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

export const SUDO_ASKPASS_ENV = 'SUDO_ASKPASS';
export const SUDO_ASKPASS_TOKEN_ENV = 'KIMI_SUDO_ASKPASS_TOKEN';
export const SUDO_ASKPASS_COMMAND_ENV = 'KIMI_SUDO_ASKPASS_COMMAND';
