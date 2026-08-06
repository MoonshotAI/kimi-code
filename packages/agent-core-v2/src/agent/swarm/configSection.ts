/**
 * `swarm` domain — `defaultSwarmMode` config section.
 *
 * Top-level boolean preference (`default_swarm_mode` on disk, v1-compatible):
 * when `true`, every freshly created session starts in swarm mode. Resumed /
 * forked sessions restore swarm state from wire records and ignore this.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_SWARM_MODE_SECTION = 'defaultSwarmMode';

export const DefaultSwarmModeSchema = z.boolean().optional();

export type DefaultSwarmMode = z.infer<typeof DefaultSwarmModeSchema>;

registerConfigSection(DEFAULT_SWARM_MODE_SECTION, DefaultSwarmModeSchema, {
  defaultValue: false,
});
