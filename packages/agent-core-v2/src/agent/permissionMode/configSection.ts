/**
 * `permissionMode` domain — registers the `defaultPermissionMode` config
 * section into `config`.
 *
 * Owns the schema for the user's default permission posture — the mode a fresh
 * main agent starts at — resolved through
 * `IConfigService.get('defaultPermissionMode')`. This section is only the
 * persisted default applied at main-agent creation; the live mode is
 * Agent-scope wire state. Self-registers at module load via
 * `registerConfigSection`, so the `config` domain never imports this domain's
 * types. Bound at App scope.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_PERMISSION_MODE_SECTION = 'defaultPermissionMode';

export const DefaultPermissionModeSchema = z.enum(['manual', 'auto', 'yolo']);

registerConfigSection(DEFAULT_PERMISSION_MODE_SECTION, DefaultPermissionModeSchema);
