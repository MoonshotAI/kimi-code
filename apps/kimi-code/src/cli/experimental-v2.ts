/**
 * Experimental agent-core-v2 engine gate.
 *
 * The `kimi server run` → server-v2 routing (see `sub/server/run.ts`) keys off
 * the master switch `KIMI_CODE_EXPERIMENTAL_FLAG`. Read directly from the env
 * (matching `cli/update/rollout.ts`) because the CLI must not depend on the core
 * flag registry. Unset / any non-truthy value keeps the v1 engine.
 *
 * `kimi -p` (print mode) routes to the native agent-core-v2 runner through a
 * dedicated switch, `KIMI_MODEL_EXPERIMENT_FLAG`, so print-mode v2 can be tried
 * independently of server-v2 and the rest of the experimental surface.
 */

export const KIMI_V2_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';
export const KIMI_PRINT_V2_ENV = 'KIMI_MODEL_EXPERIMENT_FLAG';

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

export function isPrintV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isTruthyEnv(KIMI_PRINT_V2_ENV, env);
}
