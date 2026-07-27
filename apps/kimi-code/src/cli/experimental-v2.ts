/**
 * Experimental agent-core-v2 engine gates for the CLI surfaces.
 *
 * Two independent switches, both read directly from the env (matching
 * `cli/update/rollout.ts`) because the CLI must not depend on the core flag
 * registry. Unset / any non-truthy value keeps the v1 path.
 *
 * - `KIMI_CODE_EXPERIMENTAL_FLAG` (the master switch): `kimi -p` (print
 *   mode) routes to the native agent-core-v2 runner instead of the default
 *   v1 harness (see `run-prompt.ts`). The master switch also enables every
 *   experimental feature flag in the engine.
 * - `KIMI_CODE_TUI_V2`: the interactive TUI builds its harness through the
 *   SDK's v2-backed client instead of the v1 core (see `run-shell.ts`). It
 *   is deliberately separate from the master switch — "try the v2 engine in
 *   the TUI" should not drag in every experimental feature the master
 *   switch enables, and the TUI route stays off when only the master
 *   switch is set.
 *
 * Note: `kimi web` always boots kap-server (the agent-core-v2 engine
 * server) — it consults neither switch.
 */

export const KIMI_V2_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';
export const KIMI_TUI_V2_ENV = 'KIMI_CODE_TUI_V2';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isTruthyEnv(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return TRUTHY_VALUES.has((env[key] ?? '').trim().toLowerCase());
}

export function isKimiV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isTruthyEnv(KIMI_V2_ENV, env);
}

export function isKimiTuiV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isTruthyEnv(KIMI_TUI_V2_ENV, env);
}
