/**
 * `sudoAskpass` domain (L7) — config-section schema.
 *
 * Owns the `[sudo_askpass]` configuration section: `enabled` toggles the
 * per-session sudo askpass channel (default on). Self-registered at module
 * load via `registerConfigSection`, so the `config` domain never imports
 * this domain's types.
 */

import { z } from 'zod';

import { type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SUDO_ASKPASS_SECTION = 'sudoAskpass';

export const SudoAskpassConfigSchema = z.object({
  enabled: z.boolean().optional(),
});

export type SudoAskpassConfig = z.infer<typeof SudoAskpassConfigSchema>;

export function resolveSudoAskpassConfig(
  config: IConfigService,
): SudoAskpassConfig | undefined {
  return config.get<SudoAskpassConfig | undefined>(SUDO_ASKPASS_SECTION);
}

registerConfigSection(SUDO_ASKPASS_SECTION, SudoAskpassConfigSchema);
