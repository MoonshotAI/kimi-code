import { z } from 'zod';

import { type ConfigSectionContribution } from '#/todo-features/config/index';

export const DEFAULT_PERMISSION_MODE_CONFIG_SECTION = 'defaultPermissionMode';

export const DefaultPermissionModeSchema = z.enum(['manual', 'auto', 'yolo']);

export type DefaultPermissionMode = z.infer<typeof DefaultPermissionModeSchema>;

export const defaultPermissionModeConfigSection: ConfigSectionContribution<DefaultPermissionMode> =
  {
    name: DEFAULT_PERMISSION_MODE_CONFIG_SECTION,
    schema: DefaultPermissionModeSchema,
  };
