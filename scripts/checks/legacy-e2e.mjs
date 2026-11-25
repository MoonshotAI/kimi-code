#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { reportChanges, runCountCheck, trackedFiles } from './ratchet.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK_FILE = 'scripts/checks/legacy-e2e.mjs';
const BASELINE_FILE = 'scripts/checks/baselines/legacy-e2e.json';
const RULE = 'legacy-e2e-case';
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const BUILT_IN_CASE_NAMES = ['test', 'it', 'testWithProvider'];
const CASE_MODIFIERS = String.raw`(?:\.(?:only|skip|fixme|fail|slow|todo|concurrent|sequential))*(?:\.(?:runIf|skipIf)\((?:[^()]|\([^()]*\))*\))?`;

export const LEGACY_E2E_DIRS = ['apps/desktop/e2e/', 'apps/desktop/test/e2e/', 'apps/kimi-code/test/e2e/tui/'];

export function isLegacyE2eFile(file) {
  return SOURCE_FILE.test(file) && !file.includes('node_modules/') && LEGACY_E2E_DIRS.some((dir) => file.startsWith(dir));
}

export function caseNames(text) {
  const names = new Set(BUILT_IN_CASE_NAMES);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [, specifiers] of text.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const specifier of specifiers.split(',')) {
        const [imported, local] = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        if (local !== undefined && names.has(imported) && !names.has(local)) {
          names.add(local);
          grew = true;
        }
      }
    }
    for (const [, local, source] of text.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*([\w$]+)\.extend\b/g)) {
      if (names.has(source) && !names.has(local)) {
        names.add(local);
        grew = true;
      }
    }
  }
  return [...names];
}

export function countCases(text) {
  return caseNames(text).reduce(
    (total, name) => total + [...text.matchAll(new RegExp(String.raw`(?<![\w.$])${name.replaceAll('$', '\\$')}${CASE_MODIFIERS}\(\s*['"\x60]`, 'g'))].length,
    0,
  );
}

export function countLegacyCases(files) {
  const perFile = {};
  for (const { file, text } of files) {
    if (!isLegacyE2eFile(file)) continue;
    const found = countCases(text);
    if (found > 0) perFile[file] = found;
  }
  return Object.keys(perFile).length === 0 ? {} : { [RULE]: perFile };
}

export function formatReport(changes) {
  return reportChanges(changes, {
    added: (added) => [
      '✗ legacy-e2e: new test cases in an E2E directory that no longer runs automatically',
      ...added.map((change) => `  ${change.file}: ${change.from} → ${change.to}`),
      '  instead: write the case in tests/e2e (see tests/e2e/AGENTS.md); these directories only change to migrate or delete cases',
      `  Why: ${LEGACY_E2E_DIRS.join(', ')} stopped running on pull requests and main, so a case added there looks like coverage while nothing runs it.`,
      `  What to do: move the case to tests/e2e. If you only moved or renamed an existing case inside these directories, run \`node ${CHECK_FILE} --update --allow-increase\` and say so in the PR.`,
    ],
    removed: (removed) => [
      `✗ legacy-e2e: ${BASELINE_FILE} allows more cases than these directories have`,
      ...removed.map((change) => `  ${change.file}: ${change.from} → ${change.to}`),
      '  Why: the baseline only moves down, so a migrated or deleted case cannot come back unnoticed.',
      `  What to do: run \`node ${CHECK_FILE} --update\` and commit the baseline.`,
    ],
  });
}

export function main(args) {
  return runCountCheck({
    name: 'legacy-e2e',
    root: ROOT,
    checkFile: CHECK_FILE,
    baselineFile: BASELINE_FILE,
    args,
    measure: () => countLegacyCases(trackedFiles(ROOT, isLegacyE2eFile, LEGACY_E2E_DIRS).map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }))),
    formatReport,
    summary: (counts) => {
      const perFile = counts[RULE] ?? {};
      const cases = Object.values(perFile).reduce((total, count) => total + count, 0);
      return `${cases} cases in ${Object.keys(perFile).length} files under the paused E2E directories are frozen; new cases go to tests/e2e`;
    },
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
