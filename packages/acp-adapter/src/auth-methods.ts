// Advertise the `terminal-auth` method to ACP clients. Two paths coexist:
//
//   1. First-class `type:'terminal'` per ACP 0.23 — clients re-invoke the
//      configured agent binary appending `args` (we use `['--login']` so
//      the combined command is `<binary> acp --login`, handled by the
//      `acp` subcommand's `--login` flag).
//   2. Legacy `_meta['terminal-auth']` shape — clients that don't yet
//      honor the first-class field (Zed without `AcpBetaFeatureFlag`,
//      current JetBrains plugin, etc.) read `{command,args,env,label}`
//      from `_meta` and spawn `<command> <args>` directly. Mirrors
//      kimi-cli `acp/server.py:77-96`.
//
// Most clients will hit path 1; path 2 is required for Zed today
// because the first-class handler is beta-gated.

import type { AuthMethod } from '@agentclientprotocol/sdk';

/**
 * Build the `terminal-auth` method advertised to ACP clients.
 *
 * Optional inputs:
 *  - `env`: extra env vars forwarded to the spawned `kimi login`
 *    subprocess (e.g. `{ KIMI_CODE_HOME: '/tmp/sandbox' }` for tests).
 *  - `legacyCommand`: absolute path of the agent binary, used to
 *    populate `_meta['terminal-auth'].command` so legacy clients can
 *    spawn `<binary> login` (top-level subcommand). When omitted, the
 *    `_meta` fallback is left off entirely.
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
    // Appended to the agent's configured args by spec-compliant clients
    // (e.g. `args:['acp']` + `args:['--login']` → `acp --login`). The
    // `--login` flag on `kimi acp` pivots into the login flow before
    // touching stdio.
    args: ['--login'],
    env: { ...env },
  };
  if (opts.legacyCommand !== undefined && opts.legacyCommand.length > 0) {
    (method as AuthMethod & { _meta: { 'terminal-auth': unknown } })._meta = {
      'terminal-auth': {
        type: 'terminal',
        label: 'Login with Kimi account',
        // Legacy clients use this verbatim as the executable path, NOT
        // combined with the agent server's configured command (per Zed's
        // `meta_terminal_auth_task` in `agent_servers/src/acp.rs`).
        command: opts.legacyCommand,
        // `<command> login` runs the top-level `kimi login` subcommand,
        // skipping the `acp` subprocess entirely. Same behaviour the
        // `kimi-cli` Python reference advertises.
        args: ['login'],
        env: { ...env },
      },
    };
  }
  return method;
}

/**
 * Default `terminal-auth` advertisement with no env propagation and no
 * legacy `_meta` fallback. Kept as a named export so test files that
 * only need the default shape can import it directly without going
 * through the factory.
 */
export const TERMINAL_AUTH_METHOD: AuthMethod = buildTerminalAuthMethod();
