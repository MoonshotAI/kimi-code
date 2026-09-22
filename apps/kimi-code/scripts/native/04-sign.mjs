import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { fail, run, tryRun } from './exec.mjs';
import { nativeBinPath, targetTriple } from './paths.mjs';

const ENTITLEMENTS_PATH = resolve(import.meta.dirname, 'entitlements.plist');

export function buildCodesignArgs({ identity, executable, entitlementsPath, keychainPath }) {
  if (identity === '-') {
    return ['--sign', '-', executable];
  }
  const args = [
    '--sign',
    identity,
    '--options',
    'runtime',
    '--entitlements',
    entitlementsPath,
    '--timestamp',
  ];
  if (keychainPath) {
    args.push('--keychain', keychainPath);
  }
  args.push('--force', executable);
  return args;
}

async function sha256(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function writeChecksum(executable) {
  const digest = await sha256(executable);
  await writeFile(`${executable}.sha256`, `${digest}  ${basename(executable)}\n`);
}

function azureSigningEnv() {
  const endpoint = process.env.AZURE_TRUSTED_SIGNING_ENDPOINT;
  const accountName = process.env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME;
  const profileName = process.env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME;
  if (!endpoint || !accountName || !profileName) {
    fail(
      'KIMI_AZURE_TRUSTED_SIGNING=true requires AZURE_TRUSTED_SIGNING_ENDPOINT, ' +
        'AZURE_TRUSTED_SIGNING_ACCOUNT_NAME and AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME to be set.',
    );
  }
  return { endpoint, accountName, profileName };
}

export function buildAzureSignCommand({ endpoint, accountName, profileName, executable }) {
  return (
    `Invoke-TrustedSigning -Endpoint '${endpoint}' -CertificateProfileName '${profileName}' ` +
    `-CodeSigningAccountName '${accountName}' -TimestampRfc3161 'http://timestamp.acs.microsoft.com' ` +
    `-TimestampDigest 'SHA256' -FileDigest 'SHA256' -Files '${executable}'`
  );
}

async function signWithAzureTrustedSigning(executable) {
  const { endpoint, accountName, profileName } = azureSigningEnv();
  await tryRun('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser',
  ]);
  await run('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser',
  ]);
  await run('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    buildAzureSignCommand({ endpoint, accountName, profileName, executable }),
  ]);
}

export async function runSignStep({ identity = '-', keychainPath = null } = {}) {
  const target = targetTriple();
  const executable = nativeBinPath(target);

  if (process.platform === 'darwin') {
    const args = buildCodesignArgs({
      identity,
      executable,
      entitlementsPath: ENTITLEMENTS_PATH,
      keychainPath,
    });
    await run('codesign', args);
  }
  if (process.platform === 'win32' && process.env.KIMI_AZURE_TRUSTED_SIGNING === 'true') {
    await signWithAzureTrustedSigning(executable);
  }

  await writeChecksum(executable);
  console.log(`Signed and hashed: ${executable}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? '-';
  const keychainPath = process.env.APPLE_KEYCHAIN_PATH ?? null;
  await runSignStep({ identity, keychainPath });
}
