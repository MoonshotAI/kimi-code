#!/usr/bin/env node
import { existsSync } from 'node:fs';

import { runLocalCli } from './local-cli.mjs';
import { parsePublishArguments, publishUsage } from './publish-args.mjs';
import { extensionRoot, isMainModule } from './vsix-targets.mjs';
import { verifyVsix } from './vsix-verify.mjs';

async function main() {
  const options = parsePublishArguments(process.argv.slice(2));
  if (options.help) {
    console.log(publishUsage('Open VSX'));
    return;
  }
  if (!process.env.OVSX_PAT) throw new Error('OVSX_PAT is required to publish.');

  await verifyInputs(options);
  for (const file of options.files) {
    console.log(`Publishing verified package ${file}...`);
    try {
      runLocalCli('ovsx', 'ovsx', ['publish', file], {
        cwd: extensionRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      if (/already exists/i.test(error instanceof Error ? error.message : String(error))) {
        console.log(`Package already exists: ${file}`);
        continue;
      }
      throw error;
    }
  }
}

async function verifyInputs(options) {
  for (let index = 0; index < options.targets.length; index += 1) {
    const file = options.files[index];
    if (!existsSync(file)) {
      throw new Error(`Missing VSIX ${file}. Run pnpm run package:platform first.`);
    }
    await verifyVsix(file, options.targets[index], { sourceRoot: extensionRoot });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Open VSX publish failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
