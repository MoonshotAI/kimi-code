#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './vsix-targets.mjs';

const SAFE_DIRECTORY_NAME = 'vscode-extension-dev';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(scriptDir, '../../..');
const defaultBaseDir = join(monorepoRoot, '.tmp', SAFE_DIRECTORY_NAME);

export async function prepareDevEnvironment(baseDir = defaultBaseDir) {
  const root = resolve(baseDir);
  assertSafeRoot(root);
  await rm(root, { recursive: true, force: true });

  const paths = {
    root,
    userData: join(root, 'user-data'),
    extensions: join(root, 'extensions'),
    kimiHome: join(root, 'kimi-home'),
    workspace: join(root, 'workspace'),
  };
  await Promise.all(
    Object.values(paths)
      .filter((path) => path !== root)
      .map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(
    join(paths.workspace, 'README.md'),
    '# Isolated Kimi Code extension development workspace\n',
  );
  return paths;
}

function assertSafeRoot(root) {
  const parsed = parse(root);
  if (root === parsed.root || basename(root) !== SAFE_DIRECTORY_NAME) {
    throw new Error(
      `Refusing to reset unsafe development directory "${root}"; it must end in ${SAFE_DIRECTORY_NAME}.`,
    );
  }
}

function parseArguments(argv) {
  let baseDir = defaultBaseDir;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--base-dir') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('-')) throw new Error('--base-dir requires a value.');
      baseDir = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { baseDir, help };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/prepare-dev.mjs [--base-dir <.../vscode-extension-dev>]');
    return;
  }
  const paths = await prepareDevEnvironment(options.baseDir);
  console.log(`Prepared isolated VS Code profile: ${paths.root}`);
  console.log(`KIMI_CODE_HOME=${paths.kimiHome}`);
  console.log(`Workspace=${paths.workspace}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Development environment setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
