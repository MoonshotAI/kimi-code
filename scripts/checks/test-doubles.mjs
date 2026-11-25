#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { reportChanges, runCountCheck, trackedFiles } from './ratchet.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK_FILE = 'scripts/checks/test-doubles.mjs';
const BASELINE_FILE = 'scripts/checks/baselines/test-doubles.json';
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:^|\/)(?:test|tests|e2e|__tests__)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;
const EXCLUDED_PREFIXES = [
  'scripts/checks/',
  'packages/testkit/',
  'apps/desktop/e2e/fixtures/',
  'packages/agent-core-v2/test/harness/',
];
const DESKTOP_APP_FIXTURE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*fixtures\/app['"]/g;
const DESKTOP_STUB_DSL_IMPORT = /from\s*['"][^'"]*fixtures\/model['"]/g;

export const ENGINE_HARNESS_IMPORTERS = new Map([
  [
    'packages/product/test/survey-turns.test.ts',
    'the survey counts turns, compactions and restores through engine services that only the harness agent exposes; its model replies come from a testkit model',
  ],
]);

export const LEGACY_DOUBLES = [
  {
    id: 'engine-mock-response',
    instead: 'build the agent with testkitAgentFixtures() from the agent-core-v2 harness and script replies with model.script(...)',
    applies: () => true,
    count: (text) => occurrences(text, /\bmockNext(?:Provider)?Response\(/g),
  },
  {
    id: 'engine-mock-provider',
    instead: 'build the agent with testkitAgentFixtures() and script replies with model.script(...); a reply chosen from the request becomes a testkit step function. A unit test of the loop core that only needs a requester may keep createMockProviderRequester',
    applies: () => true,
    count: (text) => occurrences(text, /(?<![\w.$])(?:createMockProvider|withMockProvider|fetchBackedProvider|createScriptedGenerate)\(/g),
  },
  {
    id: 'desktop-stub-model',
    instead: 'write the journey in tests/e2e (see tests/e2e/AGENTS.md); apps/desktop/e2e only changes to migrate or delete journeys',
    applies: (file) => file.startsWith('apps/desktop/'),
    count: (text) => {
      const stubTests = stubTestNames(text).reduce((total, name) => total + occurrences(text, new RegExp(`^\\s*${name}(?:\\.(?:only|skip|fixme|fail))?\\(`, 'gm')), 0);
      return stubTests + occurrences(text, DESKTOP_STUB_DSL_IMPORT);
    },
  },
  {
    id: 'inline-openai-stream',
    instead: 'script the reply with the testkit fake model (@moonshot-ai/testkit/model) instead of writing OpenAI stream chunks by hand',
    applies: (file) => !file.startsWith('packages/core/test/llm/'),
    count: (text) => occurrences(text, /chat\.completion\.chunk/g),
  },
  {
    id: 'engine-harness-import',
    instead: 'use @moonshot-ai/testkit; the agent-core-v2 test harness is internal to that package. A test that must drive the harness agent directly is listed in ENGINE_HARNESS_IMPORTERS with its reason',
    applies: (file) => !file.startsWith('packages/agent-core-v2/') && !ENGINE_HARNESS_IMPORTERS.has(file),
    count: (text) => occurrences(text, /agent-core-v2\/test\/harness/g),
  },
];

export function isCheckedFile(file) {
  return SOURCE_FILE.test(file) && TEST_FILE.test(file) && !file.includes('node_modules/') && !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function countLegacyDoubles(files) {
  const counts = {};
  for (const { file, text } of files) {
    if (!isCheckedFile(file)) continue;
    for (const double of LEGACY_DOUBLES) {
      if (!double.applies(file)) continue;
      const found = double.count(text);
      if (found === 0) continue;
      counts[double.id] ??= {};
      counts[double.id][file] = found;
    }
  }
  return counts;
}

export function formatReport(changes) {
  return reportChanges(changes, {
    added: (added) => [
      '✗ test-doubles: new tests use a legacy model double instead of the testkit',
      ...added.flatMap((change) => [
        `  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`,
        `    instead: ${LEGACY_DOUBLES.find((candidate) => candidate.id === change.rule)?.instead ?? 'use @moonshot-ai/testkit'}`,
      ]),
      '  Why: every layer shares one scripted model, so new tests get the same steps, holds and strict verify(). The legacy doubles stay only for existing tests until they migrate.',
      `  What to do: write the new case with the testkit. If you only moved an existing case between files, run \`node ${CHECK_FILE} --update --allow-increase\` and say so in the PR.`,
    ],
    removed: (removed) => [
      `✗ test-doubles: ${BASELINE_FILE} allows more legacy doubles than the tests use`,
      ...removed.map((change) => `  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`),
      '  Why: the baseline only moves down, so a migrated test cannot slide back to a legacy double unnoticed.',
      `  What to do: run \`node ${CHECK_FILE} --update\` and commit the baseline.`,
    ],
  });
}

export function stubTestNames(text) {
  const names = [];
  for (const [, specifiers] of text.matchAll(DESKTOP_APP_FIXTURE_IMPORT)) {
    for (const specifier of specifiers.split(',')) {
      const [imported, local] = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (imported === 'test') names.push(local ?? imported);
    }
  }
  return names;
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export function main(args) {
  return runCountCheck({
    name: 'test-doubles',
    root: ROOT,
    checkFile: CHECK_FILE,
    baselineFile: BASELINE_FILE,
    args,
    measure: () => countLegacyDoubles(trackedFiles(ROOT, isCheckedFile).map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }))),
    formatReport,
    summary: (counts) => {
      const files = new Set(Object.values(counts).flatMap((perFile) => Object.keys(perFile)));
      return `legacy model doubles frozen in ${files.size} existing test files; new tests use the testkit`;
    },
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
