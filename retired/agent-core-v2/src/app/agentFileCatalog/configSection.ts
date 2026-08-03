/**
 * `agentFileCatalog` domain (L3) — agent-file config sections.
 *
 * Registers the top-level config domain `extraAgentDirs`: additional
 * directories scanned for agent Markdown files. Values stay camelCase in
 * memory; TOML uses the snake_case key `extra_agent_dirs`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const EXTRA_AGENT_DIRS_SECTION = 'extraAgentDirs';
export const ExtraAgentDirsConfigSchema = z.array(z.string()).optional();
export type ExtraAgentDirsConfig = z.infer<typeof ExtraAgentDirsConfigSchema>;

registerConfigSection(EXTRA_AGENT_DIRS_SECTION, ExtraAgentDirsConfigSchema, {
  defaultValue: [],
});
