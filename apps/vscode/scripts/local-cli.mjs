import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function resolveLocalCli(packageName, executableName) {
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `Local CLI dependency ${packageName} is not installed. Run pnpm install; runtime CLI downloads are disabled.`,
      { cause: error },
    );
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[executableName];
  if (typeof relativeBin !== 'string') {
    throw new Error(`${packageName} does not declare the expected "${executableName}" binary.`);
  }
  return resolve(dirname(packageJsonPath), relativeBin);
}

export function runLocalCli(packageName, executableName, args, options = {}) {
  const cliPath = resolveLocalCli(packageName, executableName);
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.encoding,
    stdio: options.stdio ?? 'inherit',
  });
  if (result.error !== undefined) {
    throw new Error(`Unable to start local ${executableName}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('');
    throw new Error(
      `Local ${executableName} exited with code ${result.status ?? 'unknown'}${output ? `:\n${output}` : ''}`,
    );
  }
  return result;
}
