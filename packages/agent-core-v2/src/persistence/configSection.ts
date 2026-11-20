import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import {
  type ConfigDiagnostic,
  type EnvBindings,
  envBindings,
  type IConfigService,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject } from '#/app/config/toml';

export const DATABASE_SECTION = 'database';

export const PERSISTENCE_MINIDB_READMODEL_ENV = 'KIMI_CODE_PERSISTENCE_MINIDB_READMODEL';

const REMOVED_GLOBAL_SEARCH_CONFIG = [
  { key: 'global_search', env: 'KIMI_CODE_GLOBAL_SEARCH' },
  { key: 'search', env: 'KIMI_CODE_SEARCH_WORKER' },
  { key: 'search_sync_session_cap', env: 'KIMI_CODE_SEARCH_SYNC_SESSION_CAP' },
  { key: 'search_sync_debounce_ms', env: 'KIMI_CODE_SEARCH_SYNC_DEBOUNCE_MS' },
] as const;

export const DatabaseConfigSchema = z.object({
  base: z.boolean().optional(),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export const databaseEnvBindings: EnvBindings<DatabaseConfig> = envBindings(
  DatabaseConfigSchema,
  {
    base: { env: PERSISTENCE_MINIDB_READMODEL_ENV, parse: parseBooleanEnv },
  },
);

export const stripDatabaseEnv = stripEnvBoundFields(databaseEnvBindings);

function collectRemovedGlobalSearchDiagnostics(
  rawSection: unknown,
  getEnv: (name: string) => string | undefined,
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const { key, env } of REMOVED_GLOBAL_SEARCH_CONFIG) {
    if (isPlainObject(rawSection) && rawSection[key] !== undefined) {
      diagnostics.push({
        domain: DATABASE_SECTION,
        severity: 'warning',
        message: `[database] '${key}' has been removed with global search and is ignored. Remove the key from config.toml.`,
      });
    }
    if (getEnv(env) !== undefined) {
      diagnostics.push({
        domain: DATABASE_SECTION,
        severity: 'warning',
        message: `Environment variable ${env} has been removed with global search and is ignored. Unset it.`,
      });
    }
  }
  return diagnostics;
}

registerConfigSection(DATABASE_SECTION, DatabaseConfigSchema, {
  env: databaseEnvBindings,
  stripEnv: stripDatabaseEnv,
  collectDiagnostics: collectRemovedGlobalSearchDiagnostics,
});

export function databaseBaseEnabled(config: IConfigService): boolean {
  return config.get<DatabaseConfig | undefined>(DATABASE_SECTION)?.base ?? true;
}
