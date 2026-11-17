import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkWiring, diffConfigs } from './guards.mjs';

function config(patch = {}) {
  return {
    categories: { correctness: 'deny', pedantic: 'warn' },
    plugins: ['typescript', 'import'],
    rules: {
      'eslint/no-console': 'warn',
      'import/extensions': ['deny', ['ignorePackages', { ts: 'never' }]],
      'typescript/no-floating-promises': 'deny',
    },
    overrides: [
      {
        files: ['**/*.test.ts'],
        plugins: null,
        rules: { 'vitest/no-focused-tests': 'deny' },
      },
    ],
    ignorePatterns: ['dist/'],
    env: { builtin: true },
    globals: {},
    settings: {},
    ...patch,
  };
}

const kindsAndDetails = (findings) => findings.map((finding) => `${finding.kind}: ${finding.detail}`);

await test('diffConfigs reports nothing when the configs are equal, including null override fields', () => {
  assert.deepEqual(diffConfigs(config(), config()), []);
});

await test('diffConfigs reports a rule turned off or removed as weakened', () => {
  const after = config({
    rules: { 'eslint/no-console': 'allow', 'import/extensions': config().rules['import/extensions'] },
  });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), [
    'weakened: eslint/no-console: warn → off',
    'weakened: typescript/no-floating-promises: error → off',
  ]);
});

await test('diffConfigs reports an error rule downgraded to warn as weakened', () => {
  const after = config({ rules: { ...config().rules, 'typescript/no-floating-promises': 'warn' } });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), [
    'weakened: typescript/no-floating-promises: error → warn',
  ]);
});

await test('diffConfigs reports a promoted rule as strengthened and changed options as changed', () => {
  const after = config({
    rules: {
      ...config().rules,
      'eslint/no-console': 'deny',
      'import/extensions': ['deny', ['always']],
    },
  });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), [
    'changed: import/extensions: options changed',
    'strengthened: eslint/no-console: warn → error',
  ]);
});

await test('diffConfigs reports a newly ignored path as a weakened lint scope', () => {
  const after = config({ ignorePatterns: ['dist/', 'packages/kap-server/'] });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), [
    'weakened: ignore pattern added: packages/kap-server/',
  ]);
});

await test('diffConfigs reports a category downgrade as weakened', () => {
  const after = config({ categories: { correctness: 'warn', pedantic: 'warn' } });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), [
    'weakened: category correctness: error → warn',
  ]);
});

await test('diffConfigs reports a rule turned off inside an override', () => {
  const after = config({
    overrides: [{ files: ['**/*.test.ts'], plugins: null, rules: { 'vitest/no-focused-tests': 'allow' } }],
  });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), [
    'weakened: override **/*.test.ts: vitest/no-focused-tests: error → off',
  ]);
});

await test('diffConfigs reports an override whose file list changed as removed and added', () => {
  const after = config({
    overrides: [{ files: ['**/*.spec.ts'], plugins: null, rules: { 'vitest/no-focused-tests': 'deny' } }],
  });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), [
    'changed: override **/*.spec.ts: added',
    'changed: override **/*.test.ts: removed',
  ]);
});

const REGISTRY = {
  invocations: [
    { run: 'oxlint --type-aware --quiet', in: 'package.json#scripts.lint', why: 'lint gate' },
    { run: 'node scripts/checks/guards.mjs', in: 'package.json#scripts.lint', why: 'guards' },
    { run: 'pnpm run lint', in: '.github/workflows/ci.yml#jobs.lint', why: 'CI gate' },
    { run: 'pnpm lint-staged', in: '.husky/pre-commit', why: 'hook' },
    { run: 'node scripts/check-nix-workspace.mjs', in: '.github/workflows/nix-build.yml', contains: true, why: 'nix' },
  ],
  forbidden: [{ flags: ['--fix', '--fix-suggestions'], in: 'package.json#lint-staged', why: 'silent rewrites' }],
};

function repo(patch = {}) {
  const files = {
    'package.json': JSON.stringify({
      scripts: { lint:'oxlint --type-aware --quiet && node scripts/checks/guards.mjs' },
      'lint-staged': { '*.ts': ['oxlint --type-aware --quiet'] },
    }),
    '.github/workflows/ci.yml': [
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: pnpm run test',
      '  lint:',
      '    steps:',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm run lint',
      '',
    ].join('\n'),
    '.husky/pre-commit': 'set -e\n\npnpm lint-staged\n',
    '.github/workflows/nix-build.yml': '      run: |\n          if node scripts/check-nix-workspace.mjs; then\n',
    'scripts/checks/guards.mjs': '',
    'scripts/check-nix-workspace.mjs': '',
    ...patch,
  };
  return {
    read: (file) => files[file],
    exists: (file) => files[file] !== undefined,
  };
}

const wiring = (files) => checkWiring(REGISTRY, files.read, files.exists);

const describeFinding = (finding) =>
  `${finding.kind}: ${finding.entry.run}${finding.path === undefined ? '' : ` (${finding.path})`}`;

await test('checkWiring passes when every registered command runs where it is registered', () => {
  assert.deepEqual(wiring(repo()), []);
});

await test('checkWiring flags a check removed from the lint script', () => {
  const files = repo({
    'package.json': JSON.stringify({
      scripts: { lint:'oxlint --type-aware --quiet' },
      'lint-staged': { '*.ts': ['oxlint --type-aware --quiet'] },
    }),
  });
  assert.deepEqual(wiring(files).map(describeFinding), ['missing: node scripts/checks/guards.mjs']);
});

await test('checkWiring flags a lint command narrowed with a path argument', () => {
  const files = repo({
    'package.json': JSON.stringify({
      scripts: { lint:'oxlint --type-aware --quiet packages/core && node scripts/checks/guards.mjs' },
      'lint-staged': { '*.ts': ['oxlint --type-aware --quiet'] },
    }),
  });
  assert.deepEqual(wiring(files).map(describeFinding), ['missing: oxlint --type-aware --quiet']);
});

await test('checkWiring flags a CI command that moved out of the registered job', () => {
  const files = repo({
    '.github/workflows/ci.yml': [
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: pnpm run lint',
      '  lint:',
      '    steps:',
      '      - run: pnpm install --frozen-lockfile',
      '',
    ].join('\n'),
  });
  assert.deepEqual(wiring(files).map(describeFinding), ['missing: pnpm run lint']);
});

await test('checkWiring flags a registered script file that was deleted', () => {
  const files = repo({ 'scripts/checks/guards.mjs': undefined });
  assert.deepEqual(wiring(files).map(describeFinding), [
    'missing-file: node scripts/checks/guards.mjs (scripts/checks/guards.mjs)',
  ]);
});

await test('checkWiring flags the check of a registered location that was deleted', () => {
  const files = repo({ '.husky/pre-commit': undefined });
  assert.deepEqual(wiring(files).map(describeFinding), ['missing: pnpm lint-staged']);
});

await test('checkWiring matches an invocation embedded in a shell line when registered with contains', () => {
  const files = repo({ '.github/workflows/nix-build.yml': '      run: echo skipped\n' });
  assert.deepEqual(wiring(files).map(describeFinding), ['missing: node scripts/check-nix-workspace.mjs']);
});

await test('checkWiring flags a fix flag in the pre-commit lint command', () => {
  const files = repo({
    'package.json': JSON.stringify({
      scripts: { lint:'oxlint --type-aware --quiet && node scripts/checks/guards.mjs' },
      'lint-staged': { '*.ts': ['oxlint --fix --quiet', 'oxlint --type-aware --quiet'] },
    }),
  });
  const findings = wiring(files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'forbidden');
  assert.equal(findings[0].command, 'oxlint --fix --quiet');
  assert.equal(findings[0].flag, '--fix');
});
