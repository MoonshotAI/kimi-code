/**
 * Experimental agent-core-v2 engine gate for `kimi -p` (print mode).
 *
 * When the master switch `KIMI_CODE_EXPERIMENTAL_FLAG` is truthy, print mode
 * routes to the native agent-core-v2 runner instead of the default v1
 * harness (see `run-prompt.ts`). Read directly from the env (matching
 * `cli/update/rollout.ts`) because the CLI must not depend on the core flag
 * registry. Unset / any non-truthy value keeps the v1 harness.
 *
 * Note: `kimi server run` always boots kap-server (the agent-core-v2 engine
 * server) — it no longer consults this switch.
 */

export const KIMI_V2_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

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
