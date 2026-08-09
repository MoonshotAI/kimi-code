import { join, resolve } from 'node:path';

import {
  defaultVsixOutputDir,
  normalizeVsixTargets,
  vsixFileName,
} from './vsix-targets.mjs';

export function parsePublishArguments(argv) {
  const targets = [];
  let outputDir = defaultVsixOutputDir;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
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

  const normalizedTargets = normalizeVsixTargets(targets);
  const resolvedOutputDir = resolve(outputDir);
  return {
    help,
    targets: normalizedTargets,
    outputDir: resolvedOutputDir,
    files: normalizedTargets.map((target) => join(resolvedOutputDir, vsixFileName(target))),
  };
}

function requireOptionValue(argv, index, option) {
  const value = argv[index];
  if (value !== undefined && !value.startsWith('-')) return value;
  throw new Error(`${option} requires a value.`);
}

export function publishUsage(marketplace) {
  return [
    `Usage: node scripts/${marketplace === 'Open VSX' ? 'ovsx' : 'vsix'}-publish.mjs [targets...] [--out-dir <directory>]`,
    '',
    `Publishes already-built, re-verified VSIX files to ${marketplace}.`,
    'This command never builds or downloads a CLI.',
  ].join('\n');
}
