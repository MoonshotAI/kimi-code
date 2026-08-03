import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  collectNativeAssets,
  nativeAssetManifestKey,
  nativeAssetSummary,
} from './assets.mjs';
import { fail, run } from './exec.mjs';
import {
  appRoot,
  nativeBlobPath,
  nativeIntermediatesDir,
  nativeJsBundlePath,
  nativeManifestDir,
  nativeSeaConfigPath,
  targetTriple,
} from './paths.mjs';
import { collectWebAssets, webAssetManifestKey } from './web-assets.mjs';

async function ensureBundleExists() {
  try {
    await stat(nativeJsBundlePath());
  } catch {
    fail(`Native JS bundle not found at ${nativeJsBundlePath()}. Run 01-bundle.mjs first.`);
  }
}

async function writeSeaConfig(target) {
  await mkdir(nativeIntermediatesDir(), { recursive: true });
  const { manifest, manifestJson, assets } = await collectNativeAssets({
    appRoot,
    target,
  });
  const web = await collectWebAssets({ appRoot, target });
  const manifestPath = resolve(nativeManifestDir(target), 'manifest.json');
  const webManifestPath = resolve(nativeIntermediatesDir(), 'web-assets', target, 'manifest.json');
  await mkdir(dirname(manifestPath), { recursive: true });
  await mkdir(dirname(webManifestPath), { recursive: true });
  await writeFile(manifestPath, manifestJson);
  await writeFile(webManifestPath, web.manifestJson);

  const seaAssets = {
    [nativeAssetManifestKey(target)]: manifestPath,
    [webAssetManifestKey(target)]: webManifestPath,
    ...assets,
    ...web.assets,
  };
  const config = {
    main: nativeJsBundlePath(),
    output: nativeBlobPath(),
    assets: Object.fromEntries(
      Object.entries(seaAssets).sort(([a], [b]) => a.localeCompare(b)),
    ),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  };
  await writeFile(nativeSeaConfigPath(), `${JSON.stringify(config, null, 2)}\n`);

  console.log(`Collected native assets for ${manifest.target}:`);
  for (const line of nativeAssetSummary(manifest)) {
    console.log(`- ${line}`);
  }
  console.log(
    `Collected web assets for ${web.manifest.target}: ${web.manifest.files.length} files`,
  );
}

export async function runSeaBlobStep() {
  await ensureBundleExists();
  const target = targetTriple();
  await writeSeaConfig(target);
  await run(process.execPath, ['--experimental-sea-config', nativeSeaConfigPath()]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runSeaBlobStep();
}
