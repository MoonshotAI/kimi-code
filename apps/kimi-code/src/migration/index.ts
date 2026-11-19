export { registerMigrateCommand, type MigrateCommandOptions } from './command';
export { formatSessionLabel, isImportedSession, type SessionLabelInput } from './badge';
export { detectPendingMigration } from './detect-pending';
export { MIGRATE_HEADLESS_EXIT, runHeadlessMigrate } from './run-headless';
export {
  resolveLegacySourceHome,
  sameLegacyPath,
  type LegacySourceResolution,
} from './legacy-source';
export { MigrationScreenComponent, type MigrationScreenResult } from './migration-screen';
