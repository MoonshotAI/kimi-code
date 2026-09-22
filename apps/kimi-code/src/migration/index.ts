/**
 * kimi-cli → kimi-code migration: host integration surface.
 *
 * Removable glue: the `kimi migrate` sub-command, the first-launch detection,
 * and the session-picker `[imported]` badge helper. Migration logic itself
 * lives in `@moonshot-ai/migration-legacy`. The native pi-tui migration screen
 * (`./migration-screen`) is deliberately not re-exported here: this barrel is
 * imported on every CLI start, and the screen would drag the terminal UI in.
 */
export { registerMigrateCommand, type MigrateCommandOptions } from './command';
export { formatSessionLabel, isImportedSession, type SessionLabelInput } from './badge';
export { detectPendingMigration } from './detect-pending';
export { MIGRATE_HEADLESS_EXIT, runHeadlessMigrate } from './run-headless';
export {
  resolveLegacySourceHome,
  sameLegacyPath,
  type LegacySourceResolution,
} from './legacy-source';
