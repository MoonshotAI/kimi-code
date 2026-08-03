import { resolve } from 'node:path';

import {
  BUNDLED_PLUGINS_MANIFEST_VERSION,
  buildBundledPluginsAssetKey,
  buildBundledPluginsManifestKey,
} from './manifest.mjs';
import { collectAssetRoot } from './web-assets.mjs';

export { BUNDLED_PLUGINS_MANIFEST_VERSION };

const BUNDLED_PLUGINS_DIR = 'bundled-plugins';

export function bundledPluginsManifestKey(target) {
  return buildBundledPluginsManifestKey(target);
}

export function bundledPluginsAssetKey(target, relativePath) {
  return buildBundledPluginsAssetKey(target, relativePath);
}

export async function collectBundledPlugins({ appRoot, target }) {
  const buildCommand = 'pnpm --filter @moonshot-ai/kimi-code run build';
  return collectAssetRoot({
    appRoot,
    target,
    root: BUNDLED_PLUGINS_DIR,
    requiredFile: 'kimi-webbridge/kimi.plugin.json',
    missingMessage: `Bundled capability plugins were not found at ${resolve(appRoot, BUNDLED_PLUGINS_DIR)}. Run \`${buildCommand}\` (or scripts/copy-bundled-plugins.mjs) before building native SEA assets. App root: ${appRoot}`,
    assetKey: bundledPluginsAssetKey,
    version: BUNDLED_PLUGINS_MANIFEST_VERSION,
  });
}
