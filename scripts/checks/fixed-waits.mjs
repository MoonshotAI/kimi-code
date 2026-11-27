#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { reportChanges, runCountCheck, trackedFiles } from './ratchet.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK_FILE = 'scripts/checks/fixed-waits.mjs';
const BASELINE_FILE = 'scripts/checks/baselines/fixed-waits.json';
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:^|\/)(?:test|tests|e2e|__tests__)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;
const EXCLUDED_PREFIXES = ['scripts/checks/'];
const INSTEAD = 'wait for a signal instead: an event, a held testkit step, vi.waitFor or expect.poll on a condition, or vi.useFakeTimers when the code under test waits on time';
const PROMISE_TIMER = /new Promise(?:<[^>]*>)?\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)[^)]*\)?\s*=>\s*\{?\s*(?:void\s+)?(?:globalThis\.)?set(?:Timeout|Immediate)\(\s*(?:\1\b|\(\)\s*=>\s*\{?\s*\1\()/g;
const TIMERS_PROMISES_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?timers\/promises['"]/g;

export const FIXED_WAITS = [
  {
    id: 'promise-timer',
    what: 'a promise resolved by setTimeout or setImmediate',
    count: (text) => occurrences(text, PROMISE_TIMER),
  },
  {
    id: 'timers-promises',
    what: 'a timer from node:timers/promises',
    count: (text) => timerPromiseNames(text).reduce((total, name) => total + occurrences(text, new RegExp(String.raw`(?<![\w.$])${name.replaceAll('$', '\\$')}\(`, 'g')), 0),
  },
  {
    id: 'wait-for-timeout',
    what: "Playwright's waitForTimeout",
    count: (text) => occurrences(text, /\bwaitForTimeout\(/g),
  },
];

export function isCheckedFile(file) {
  return SOURCE_FILE.test(file) && TEST_FILE.test(file) && !file.includes('node_modules/') && !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function countFixedWaits(files) {
  const counts = {};
  for (const { file, text } of files) {
    if (!isCheckedFile(file)) continue;
    for (const wait of FIXED_WAITS) {
      const found = wait.count(text);
      if (found === 0) continue;
      counts[wait.id] ??= {};
      counts[wait.id][file] = found;
    }
  }
  return counts;
}

export function timerPromiseNames(text) {
  const names = [];
  for (const [, specifiers] of text.matchAll(TIMERS_PROMISES_IMPORT)) {
    for (const specifier of specifiers.split(',')) {
      const [imported, local] = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (imported === 'setTimeout' || imported === 'setImmediate') names.push(local ?? imported);
    }
  }
  return names;
}

export function formatReport(changes) {
  return reportChanges(changes, {
    added: (added) => [
      '✗ fixed-waits: new code in tests waits a fixed time',
      ...added.flatMap((change) => [
        `  ${change.rule} in ${change.file}: ${change.from} → ${change.to} (${FIXED_WAITS.find((wait) => wait.id === change.rule)?.what ?? 'a fixed wait'})`,
        `    instead: ${INSTEAD}`,
      ]),
      '  Why: a test that sleeps passes only while the machine is fast enough, and on a loaded CI runner the same wait turns into a flaky failure. AGENTS.md rules out sleep- and timeout-based synchronization.',
      `  What to do: replace the wait with a signal. If you only moved an existing wait between files, run \`node ${CHECK_FILE} --update --allow-increase\` and say so in the PR.`,
    ],
    removed: (removed) => [
      `✗ fixed-waits: ${BASELINE_FILE} allows more fixed waits than the tests use`,
      ...removed.map((change) => `  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`),
      '  Why: the baseline only moves down, so a removed wait cannot come back unnoticed.',
      `  What to do: run \`node ${CHECK_FILE} --update\` and commit the baseline.`,
    ],
  });
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export function main(args) {
  return runCountCheck({
    name: 'fixed-waits',
    root: ROOT,
    checkFile: CHECK_FILE,
    baselineFile: BASELINE_FILE,
    args,
    measure: () => countFixedWaits(trackedFiles(ROOT, isCheckedFile).map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }))),
    formatReport,
    summary: (counts) => {
      const perFile = Object.values(counts).flatMap((byFile) => Object.entries(byFile));
      const total = perFile.reduce((sum, [, count]) => sum + count, 0);
      return `${total} fixed waits frozen in ${new Set(perFile.map(([file]) => file)).size} existing test files; new tests wait for signals`;
    },
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
