import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Read a local plugin directory's declared version from its manifest, mirroring
// the plugin loader's precedence (packages/agent-core/src/plugin/manifest.ts):
// `kimi.plugin.json` is authoritative once it exists, and `.kimi-plugin/plugin.json`
// is only consulted when the root manifest is absent. Returns undefined when no
// manifest is present or the chosen manifest has no version — callers then leave
// the marketplace entry's existing version untouched.
export async function readPluginManifestVersion(pluginDir) {
  for (const rel of ['kimi.plugin.json', '.kimi-plugin/plugin.json']) {
    const raw = await readFileOrUndefined(resolve(pluginDir, rel));
    if (raw === undefined) continue; // manifest absent — fall back to the next candidate
    return versionFromManifest(raw); // the chosen manifest wins, even if it has no version
  }
  return undefined;
}

async function readFileOrUndefined(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function versionFromManifest(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string') {
      const trimmed = parsed.version.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
