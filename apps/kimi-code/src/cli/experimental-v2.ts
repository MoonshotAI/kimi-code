/**
 * Agent engine routing gates for the CLI surfaces.
 *
 * `kimi -p`, the interactive TUI, and `kimi doctor` use the native
 * agent-core-v2 path by default. A truthy `KIMI_CODE_LEGACY_FLAG` selects the
 * legacy agent-core-backed path instead. `KIMI_CODE_EXPERIMENTAL_FLAG` remains
 * the master switch for experimental features within either engine; it does
 * not select the engine.
 *
 * Note: `kimi web` always boots kap-server (the agent-core-v2 engine
 * server) — it does not consult this switch.
 */

export const KIMI_LEGACY_ENV = 'KIMI_CODE_LEGACY_FLAG';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isTruthyEnv(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return TRUTHY_VALUES.has((env[key] ?? '').trim().toLowerCase());
}

export function isLegacyEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isTruthyEnv(KIMI_LEGACY_ENV, env);
}

export function isKimiV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !isLegacyEnabled(env);
}
