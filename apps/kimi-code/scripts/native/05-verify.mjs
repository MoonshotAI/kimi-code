import { run } from './exec.mjs';
import { nativeBinPath, targetTriple } from './paths.mjs';

export async function runVerifyStep({ requireGatekeeper = false } = {}) {
  const target = targetTriple();
  const executable = nativeBinPath(target);

  if (process.platform === 'win32') {
    if (process.env.KIMI_AZURE_TRUSTED_SIGNING !== 'true') {
      console.log('Verify step skipped (unsigned Windows build)');
      return;
    }
    console.log(`==> Get-AuthenticodeSignature ${executable}`);
    await run('pwsh', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$sig = Get-AuthenticodeSignature '${executable}'; ` +
        '"$($sig.Status) | $($sig.SignerCertificate.Subject)"; ' +
        "if ($sig.Status -ne 'Valid') { exit 1 }",
    ]);
    return;
  }

  if (process.platform !== 'darwin') {
    console.log('Verify step skipped (not macOS)');
    return;
  }

  console.log(`==> codesign -dv ${executable}`);
  await run('codesign', ['-dv', '--verbose=2', executable]);

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
