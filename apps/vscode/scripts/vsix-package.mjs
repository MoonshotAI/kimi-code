#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { runLocalCli } from './local-cli.mjs';
import {
  defaultVsixOutputDir,
  extensionRoot,
  isMainModule,
  normalizeVsixTargets,
  vsixFileName,
} from './vsix-targets.mjs';
import { verifyVsix } from './vsix-verify.mjs';

const require = createRequire(import.meta.url);

function parseArguments(argv) {
  const targets = [];
  let outputDir = defaultVsixOutputDir;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--out-dir') {
      outputDir = requireOptionValue(argv, ++index, '--out-dir');
    } else if (argument === '--target') {
      targets.push(requireOptionValue(argv, ++index, '--target'));
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      targets.push(argument);
    }
  }

  return {
    targets: normalizeVsixTargets(targets),
    outputDir: resolve(outputDir),
    dryRun,
    help,
  };
}

function requireOptionValue(argv, index, option) {
  const value = argv[index];
  if (value !== undefined && !value.startsWith('-')) return value;
  throw new Error(`${option} requires a value.`);
}

function usage() {
  return [
    'Usage: node scripts/vsix-package.mjs [targets...] [--out-dir <directory>]',
    '       node scripts/vsix-package.mjs --target win32-x64 --dry-run',
    '',
    'With no targets, all six supported VSIX targets are built and audited.',
    'This command never publishes an extension.',
  ].join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  console.log(`VSIX targets: ${options.targets.join(', ')}`);
  console.log(`Output directory: ${options.outputDir}`);

  if (!options.dryRun) {
    console.log('Building the extension once before packaging all targets...');
    buildExtension();
  }

  const packVsix = options.dryRun ? undefined : loadVscePack();

  for (const target of options.targets) {
    const outputPath = join(options.outputDir, vsixFileName(target));
    if (options.dryRun) {
      console.log(`Would package ${target} -> ${outputPath}`);
      continue;
    }

    console.log(`\nPackaging ${target} with the workspace @vscode/vsce...`);
    await packVsix({
      cwd: extensionRoot,
      dependencies: false,
      packagePath: outputPath,
      target,
    });
    const result = await verifyVsix(outputPath, target, { sourceRoot: extensionRoot });
    console.log(
      `Verified ${target}: ${result.files} files, ${result.bytes} unpacked bytes; package/static checks passed.`,
    );
  }

  if (!options.dryRun) {
    console.log(
      '\nVSIX packaging complete. These are package-only results until each target runs in its matching extension host.',
    );
  }
}

function buildExtension() {
  runLocalCli('tsdown', 'tsdown', ['--config', 'tsdown.config.ts'], { cwd: extensionRoot });
  runLocalCli('vite', 'vite', ['build', '--config', 'webview-ui/vite.config.ts'], {
    cwd: extensionRoot,
  });
}

function loadVscePack() {
  try {
    // VSCE's public API always runs vscode:prepublish. We build once above and pin VSCE,
    // so use its package phase directly instead of rebuilding for every target.
    const module = require('@vscode/vsce/out/package.js');
    if (typeof module.pack !== 'function') {
      throw new TypeError('the installed package does not expose pack()');
    }
    return module.pack;
  } catch (error) {
    throw new Error(
      'The workspace @vscode/vsce package API is unavailable. Run pnpm install; runtime CLI downloads are disabled.',
      { cause: error },
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`VSIX packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
