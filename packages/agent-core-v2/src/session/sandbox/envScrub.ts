/**
 * `sandbox` domain (L3) — sensitive environment-variable classification.
 *
 * Pure classifier for host env names that must not leak into a sandboxed
 * command's environment: case-insensitive suffixes (`_API_KEY`, `_KEY`,
 * `_TOKEN`, `_SECRET`, `_PASSWORD`, `_CREDENTIALS`) plus an exact list of
 * agent/socket variables (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`,
 * `GPG_AGENT_INFO`, `XAUTHORITY`). The Bash tool scrubs the hits to empty
 * strings in its exec overlay when a command runs sandboxed.
 */

const SENSITIVE_ENV_SUFFIXES = [
  '_API_KEY',
  '_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
] as const;

const SENSITIVE_ENV_EXACT: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GPG_AGENT_INFO',
  'XAUTHORITY',
]);

export function sensitiveEnvNames(names: readonly string[]): readonly string[] {
  return names.filter(isSensitiveEnvName);
}

export function isSensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SENSITIVE_ENV_EXACT.has(upper)) return true;
  return SENSITIVE_ENV_SUFFIXES.some(
    (suffix) => upper.length > suffix.length && upper.endsWith(suffix),
  );
}
