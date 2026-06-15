import { resolve } from 'node:path';

import { run } from './exec.mjs';
import { resolveExecutableFileRelatives } from './native-deps.mjs';
import { nativeBinDir, nativeBinPath, targetTriple } from './paths.mjs';

export async function runVerifyStep({ requireGatekeeper = false } = {}) {
  if (process.platform !== 'darwin') {
    console.log('Verify step skipped (not macOS)');
    return;
  }

  const target = targetTriple();
  const executable = nativeBinPath(target);

  console.log(`==> codesign -dv ${executable}`);
  await run('codesign', ['-dv', '--verbose=2', executable]);

  for (const relativePath of resolveExecutableFileRelatives(target)) {
    const file = resolve(nativeBinDir(target), relativePath);
    console.log(`==> codesign --verify ${file}`);
    await run('codesign', ['--verify', '--strict', '--verbose=2', file]);
    console.log(`==> codesign -dv ${file}`);
    await run('codesign', ['-dv', '--verbose=2', file]);
  }

  if (requireGatekeeper) {
    // spctl in 'install' mode simulates the Gatekeeper online check — only a
    // fully notarized binary passes. Ad-hoc signed binaries fail, so this is
    // only run under the release profile.
    console.log(`==> spctl -a -vvv -t install ${executable}`);
    await run('spctl', ['-a', '-vvv', '-t', 'install', executable]);
  } else {
    console.log('Skipping spctl check (requireGatekeeper=false)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const requireGatekeeper = process.env.KIMI_VERIFY_GATEKEEPER === '1';
  await runVerifyStep({ requireGatekeeper });
}
