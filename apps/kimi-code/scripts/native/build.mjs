import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { runBundleStep } from './01-bundle.mjs';
import { runInjectStep } from './03-inject.mjs';
import { runSeaBlobStep } from './02-sea-blob.mjs';
import { runSignStep } from './04-sign.mjs';
import { runVerifyStep } from './05-verify.mjs';
import { run } from './exec.mjs';
import { appRoot, nativeIntermediatesDir } from './paths.mjs';
import { BUILT_IN_CATALOG_ENV } from '../built-in-catalog.mjs';

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'local' },
  },
});

const profile = values.profile;
if (!['local', 'release'].includes(profile)) {
  console.error(`Unknown profile: ${profile}. Expected 'local' or 'release'.`);
  process.exit(1);
}

function ensureNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    console.error(
      `Kimi Code native SEA build requires Node.js >=24.15.0, current ${process.versions.node}.`,
    );
    process.exit(1);
  }
}

ensureNodeVersion();
console.log(`==> Native build (profile=${profile})`);

if (profile === 'release' && process.env[BUILT_IN_CATALOG_ENV] === undefined) {
  const catalogPath = resolve(nativeIntermediatesDir(), 'built-in-catalog.json');
  await run(process.execPath, [resolve(appRoot, 'scripts/update-catalog.mjs'), '--out', catalogPath]);
  process.env[BUILT_IN_CATALOG_ENV] = catalogPath;
}

await runBundleStep();
await runSeaBlobStep();
await runInjectStep();

const identity =
  profile === 'release' ? (process.env.APPLE_SIGNING_IDENTITY ?? '-') : '-';
const keychainPath = profile === 'release' ? (process.env.APPLE_KEYCHAIN_PATH ?? null) : null;
await runSignStep({ identity, keychainPath });

// Verify always runs (codesign -dv); spctl gatekeeper gate only after notarization
// (CI macos-notarize composite action) — orchestrator just self-checks signing here.
await runVerifyStep({ requireGatekeeper: false });

console.log('==> Native build complete');
