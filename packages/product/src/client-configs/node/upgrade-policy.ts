import { lt, valid } from 'semver';
import { z } from 'zod';

export const CLIENT_UPGRADE_POLICY_CONFIG_NAME = 'client_upgrade_policy';

export interface ClientUpgradePolicy {
  readonly cliMinVersion: string | null;
  readonly desktopMinVersion: string | null;
}

function minimumVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return valid(value);
}

export const clientUpgradePolicySchema = z.unknown().transform((raw): ClientUpgradePolicy => {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  return {
    cliMinVersion: minimumVersion(record['cli_min_version']),
    desktopMinVersion: minimumVersion(record['desktop_min_version']),
  };
});

export function isUpgradeRequired(
  currentVersion: string,
  minimumVersion: string | null | undefined,
): boolean {
  if (minimumVersion === null || minimumVersion === undefined) return false;
  const current = valid(currentVersion);
  const minimum = valid(minimumVersion);
  return current !== null && minimum !== null && lt(current, minimum);
}
