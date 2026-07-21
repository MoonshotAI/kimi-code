import type { Kaos } from '@moonshot-ai/kaos';
import { join } from 'pathe';

import type { SkillRoot } from '../skill/types';
import type { PluginManifest } from './types';

/**
 * Scan project-level plugin directories for plugins.
 * Each directory is expected to contain plugin subdirectories with
 * `kimi-plugin.json` manifest files.
 */
export async function scanProjectPluginDirs(
  kaos: Kaos,
  pluginDirs: readonly string[],
): Promise<readonly SkillRoot[]> {
  const roots: SkillRoot[] = [];

  for (const pluginDir of pluginDirs) {
    try {
      for await (const entryPath of kaos.iterdir(pluginDir)) {
        const manifestPath = join(entryPath, 'kimi-plugin.json');
        const manifest = await readProjectPluginManifest(kaos, manifestPath);
        if (manifest === undefined || manifest.skills === undefined) continue;
        for (const skillPath of manifest.skills) {
          roots.push({
            path: skillPath,
            source: 'extra',
            plugin: {
              id: manifest.name,
              instructions: manifest.skillInstructions,
            },
          });
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  return roots;
}

async function readProjectPluginManifest(
  kaos: Kaos,
  manifestPath: string,
): Promise<PluginManifest | undefined> {
  try {
    const text = await kaos.readText(manifestPath);
    const parsed = JSON.parse(text) as PluginManifest;
    if (typeof parsed.name !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
