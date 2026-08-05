// Advertise the `terminal-auth` method to ACP clients. Two paths coexist:
//
//   1. First-class `type:'terminal'` per ACP 0.23 — clients re-invoke the
//      configured agent binary appending `args` (we use `['--login']` so the
//      combined command is `<binary> <agent-args> --login`, handled by the
//      subcommand's `--login` flag).
//   2. Legacy `_meta['terminal-auth']` shape — clients that don't yet honor
//      the first-class field (Zed without `AcpBetaFeatureFlag`, current
//      JetBrains plugin, etc.) read `{command,args,env,label}` from `_meta`
//      and spawn `<command> <args>` directly.
//
// Most clients hit path 1; path 2 is required for Zed today because the
// first-class handler is beta-gated. Mirrors `packages/acp-adapter` so the
// v1 and v2 ACP hosts advertise identical login surfaces.

import type { AuthMethod } from '@agentclientprotocol/sdk';

/**
 * Build the `terminal-auth` method advertised to ACP clients.
 *
 * Optional inputs:
 *  - `env`: extra env vars forwarded to the spawned login subprocess (e.g.
 *    `{ KIMI_CODE_HOME: '/tmp/sandbox' }` so the token lands under the same
 *    data root the server reads from).
 *  - `legacyCommand`: absolute path of the agent binary, used to populate
 *    `_meta['terminal-auth'].command` so legacy clients can spawn it directly.
 *    When omitted, the `_meta` fallback is left off entirely.
 */
export function buildTerminalAuthMethod(
  opts: {
    env?: Readonly<Record<string, string>>;
    legacyCommand?: string;
  } = {},
): AuthMethod {
  const env = opts.env ?? {};
  const method: AuthMethod = {
    id: 'login',
    type: 'terminal',
    name: 'Login with Kimi account',
    description: 'Open the device-code login flow in a terminal.',
    args: ['--login'],
    env: { ...env },
  };
  if (opts.legacyCommand !== undefined && opts.legacyCommand.length > 0) {
    (method as AuthMethod & { _meta: { 'terminal-auth': unknown } })._meta = {
      'terminal-auth': {
        type: 'terminal',
        label: 'Login with Kimi account',
        command: opts.legacyCommand,
        args: ['login'],
        env: { ...env },
      },
    };
  }
  return method;
}

/**
 * Default `terminal-auth` advertisement with no env propagation and no legacy
 * `_meta` fallback.
 */
export const TERMINAL_AUTH_METHOD: AuthMethod = buildTerminalAuthMethod();
