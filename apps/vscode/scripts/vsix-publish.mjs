#!/usr/bin/env node
import { existsSync } from 'node:fs';

import { runLocalCli } from './local-cli.mjs';
import { parsePublishArguments, publishUsage } from './publish-args.mjs';
import { extensionRoot, isMainModule } from './vsix-targets.mjs';
import { verifyVsix } from './vsix-verify.mjs';

async function main() {
  const options = parsePublishArguments(process.argv.slice(2));
  if (options.help) {
    console.log(publishUsage('Visual Studio Marketplace'));
    return;
  }
  if (!process.env.VSCE_PAT) throw new Error('VSCE_PAT is required to publish.');

  await verifyInputs(options);
  for (const file of options.files) {
    console.log(`Publishing verified package ${file}...`);
    runLocalCli(
      '@vscode/vsce',
      'vsce',
      ['publish', '--packagePath', file, '--skip-duplicate'],
      { cwd: extensionRoot },
    );
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
    console.error(`Marketplace publish failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
