import type { EnabledPluginSystemPrompt } from '../plugin/types';

/**
 * Soft aggregate budget for the plugin system-prompt sections injected into
 * one prompt build. Per-plugin content is already capped at manifest parse
 * time (`PLUGIN_SYSTEM_PROMPT_MAX_BYTES`); this caps the combined block so a
 * pile of enabled plugins cannot flood the system prompt. Contributions that
 * do not fit are skipped and reported through `skipped` — callers surface a
 * user-visible warning.
 */
export const PLUGIN_SECTIONS_MAX_BYTES = 64 * 1024;

export interface ComposedPluginSections {
  readonly content: string;
  /** Ids of plugins whose contributions were skipped because the budget ran out. */
  readonly skipped: readonly string[];
}

export function composePluginSections(
  sections: readonly EnabledPluginSystemPrompt[],
): ComposedPluginSections {
  const parts: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  for (const section of sections) {
    const block = `<!-- From: plugin ${section.pluginId} -->\n${section.content}`;
    const bytes = Buffer.byteLength(block, 'utf8');
    if (totalBytes + bytes > PLUGIN_SECTIONS_MAX_BYTES) {
      skipped.push(section.pluginId);
      continue;
    }
    totalBytes += bytes;
    parts.push(block);
  }
  return { content: parts.join('\n\n'), skipped };
}
