import { join } from 'node:path';

// Source (~/.kimi/) paths
export const sourceCredentialsDir = (src: string): string => join(src, 'credentials');
export const sourceSessionsDir = (src: string): string => join(src, 'sessions');
export const sourceUserHistoryDir = (src: string): string => join(src, 'user-history');
export const sourceSkillsDir = (src: string): string => join(src, 'skills');
export const sourceKimiJson = (src: string): string => join(src, 'kimi.json');
export const sourceConfigToml = (src: string): string => join(src, 'config.toml');
export const sourceMcpJson = (src: string): string => join(src, 'mcp.json');
export const sourceMcpOauthDir = (src: string): string => join(src, 'mcp-oauth');
export const sourcePluginsDir = (src: string): string => join(src, 'plugins');
export const migratedMarker = (src: string): string => join(src, '.migrated-to-kimi-code');

// Target (~/.kimi-code/) paths
export const targetSessionsDir = (tgt: string): string => join(tgt, 'sessions');
export const targetUserHistoryDir = (tgt: string): string => join(tgt, 'user-history');
export const targetSkillsDir = (tgt: string): string => join(tgt, 'skills');
export const targetConfigFile = (tgt: string): string => join(tgt, 'config.toml');
export const targetTuiFile = (tgt: string): string => join(tgt, 'tui.toml');
export const targetMcpFile = (tgt: string): string => join(tgt, 'mcp.json');
export const targetSessionIndex = (tgt: string): string => join(tgt, 'session_index.jsonl');
export const migrationReportFile = (tgt: string): string => join(tgt, 'migration-report.json');
export const migrationErrorsLogFile = (tgt: string): string => join(tgt, 'migration-errors.log');
export const skipMarker = (tgt: string): string => join(tgt, '.skip-migration-from-kimi-cli');

// Sibling fallback paths used when target file conflicts with user-modified content
export const siblingConfigToml = (tgt: string): string =>
  join(tgt, 'config.migrated-from-kimi-cli.toml');
export const siblingTuiToml = (tgt: string): string =>
  join(tgt, 'tui.migrated-from-kimi-cli.toml');
export const siblingMcpJson = (tgt: string): string =>
  join(tgt, 'mcp.migrated-from-kimi-cli.json');
