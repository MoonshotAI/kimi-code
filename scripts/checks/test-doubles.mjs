#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { compareCounts } from './ratchet.mjs';

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
  'apps/vscode/test/fake-provider-harness.ts',
];
const DESKTOP_APP_FIXTURE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*fixtures\/app['"]/g;
const DESKTOP_STUB_DSL_IMPORT = /from\s*['"][^'"]*fixtures\/model['"]/g;

export const LEGACY_DOUBLES = [
  {
    id: 'engine-mock-response',
    instead: 'build the agent with testkitAgentFixtures() from the agent-core-v2 harness and script replies with model.script(...)',
    applies: () => true,
    count: (text) => occurrences(text, /\bmockNext(?:Provider)?Response\(/g),
  },
  {
    id: 'desktop-stub-model',
    instead: 'write the journey with testWithProvider from apps/desktop/e2e/fixtures/app.ts and script the testkit provider',
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
    id: 'vscode-fake-provider',
    instead: 'point the extension at the testkit fake model (@moonshot-ai/testkit/model)',
    applies: () => true,
    count: (text) => occurrences(text, /fake-provider-harness/g),
  },
  {
    id: 'engine-harness-import',
    instead: 'use @moonshot-ai/testkit; the agent-core-v2 test harness is internal to that package',
    applies: (file) => !file.startsWith('packages/agent-core-v2/'),
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
  const lines = [];
  const added = changes.filter((change) => change.kind === 'added');
  const removed = changes.filter((change) => change.kind === 'removed');
  if (added.length > 0) {
    lines.push('✗ test-doubles: new tests use a legacy model double instead of the testkit');
    for (const change of added) {
      const double = LEGACY_DOUBLES.find((candidate) => candidate.id === change.rule);
      lines.push(`  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`, `    instead: ${double?.instead ?? 'use @moonshot-ai/testkit'}`);
    }
    lines.push(
      '  Why: every layer shares one scripted model, so new tests get the same steps, holds and strict verify(). The legacy doubles stay only for existing tests until they migrate.',
      `  What to do: write the new case with the testkit. If you only moved an existing case between files, run \`node ${CHECK_FILE} --update --allow-increase\` and say so in the PR.`,
    );
  }
  if (removed.length > 0) {
    lines.push(
      `✗ test-doubles: ${BASELINE_FILE} allows more legacy doubles than the tests use`,
      ...removed.map((change) => `  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`),
      '  Why: the baseline only moves down, so a migrated test cannot slide back to a legacy double unnoticed.',
      `  What to do: run \`node ${CHECK_FILE} --update\` and commit the baseline.`,
    );
  }
  return lines;
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

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\0').filter((file) => file !== '' && isCheckedFile(file) && existsSync(join(ROOT, file)));
}

function sortCounts(counts) {
  return Object.fromEntries(
    Object.keys(counts)
      .toSorted()
      .map((id) => [id, Object.fromEntries(Object.keys(counts[id]).toSorted().map((file) => [file, counts[id][file]]))]),
  );
}

export function main(args) {
  const known = new Set(['--update', '--allow-increase']);
  if (args.some((arg) => !known.has(arg)) || (args.includes('--allow-increase') && !args.includes('--update'))) {
    process.stderr.write(`✗ test-doubles: unsupported arguments ${args.join(' ')}. Run \`pnpm lint\`; \`node ${CHECK_FILE} --update\` lowers ${BASELINE_FILE}.\n`);
    return 2;
  }
  const counts = countLegacyDoubles(trackedFiles().map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') })));
  const baselinePath = join(ROOT, BASELINE_FILE);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  const changes = compareCounts(baseline, counts);
  if (args.includes('--update')) {
    const added = changes.filter((change) => change.kind === 'added');
    if (added.length > 0 && !args.includes('--allow-increase')) {
      process.stderr.write(`${formatReport(added).join('\n')}\n`);
      return 1;
    }
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(sortCounts(counts), null, 2)}\n`);
    process.stdout.write(`✓ test-doubles: wrote ${BASELINE_FILE}\n`);
    return 0;
  }
  const report = formatReport(changes);
  if (report.length > 0) {
    process.stderr.write(`${report.join('\n')}\n`);
    return 1;
  }
  const files = new Set(Object.values(counts).flatMap((perFile) => Object.keys(perFile)));
  process.stdout.write(`✓ test-doubles: legacy model doubles frozen in ${files.size} existing test files; new tests use the testkit\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
