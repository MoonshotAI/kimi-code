import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stringify } from 'yaml';

import { checkFanIn, checkWiring, diffConfigs, expandOverridePlugins, normalizeConfig } from './guards.mjs';

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

await test('diffConfigs reports nothing when only the order of the JS plugins differs', () => {
  const before = config({ jsPlugins: ['./scripts/a-lint-plugin.mjs', './apps/b-lint-plugin.mjs'] });
  const after = config({ jsPlugins: ['./apps/b-lint-plugin.mjs', './scripts/a-lint-plugin.mjs'] });
  assert.deepEqual(diffConfigs(before, after), []);
});

await test('diffConfigs reports a removed JS plugin as weakened and an added one as changed', () => {
  const before = config({ jsPlugins: ['./scripts/a-lint-plugin.mjs', './apps/b-lint-plugin.mjs'] });
  const after = config({ jsPlugins: ['./apps/b-lint-plugin.mjs', './apps/c-lint-plugin.mjs'] });
  assert.deepEqual(kindsAndDetails(diffConfigs(before, after)), [
    'weakened: JS plugin removed: ./scripts/a-lint-plugin.mjs',
    'changed: JS plugin added: ./apps/c-lint-plugin.mjs',
  ]);
});

await test('normalizeConfig records the JS plugins in one order whatever order oxlint prints them in', () => {
  const printed = (jsPlugins) => config({ jsPlugins });
  assert.deepEqual(
    normalizeConfig(printed(['./scripts/a-lint-plugin.mjs', './apps/b-lint-plugin.mjs']), []),
    normalizeConfig(printed(['./apps/b-lint-plugin.mjs', './scripts/a-lint-plugin.mjs']), []),
  );
});

await test('diffConfigs reports a change in any other top-level key, such as options', () => {
  const after = config({ options: { typeAware: false } });
  assert.deepEqual(kindsAndDetails(diffConfigs(config(), after)), ['changed: options changed']);
});

const CATALOG = [
  { scope: 'vitest', value: 'no-focused-tests', category: 'correctness' },
  { scope: 'vitest', value: 'no-conditional-expect', category: 'correctness' },
  { scope: 'vitest', value: 'no-conditional-in-test', category: 'pedantic' },
  { scope: 'vitest', value: 'prefer-lowercase-title', category: 'style' },
  { scope: 'jest', value: 'no-hooks', category: 'correctness' },
];

const withVitest = (rules) =>
  config({ overrides: [{ files: ['**/*.test.ts'], plugins: ['vitest'], rules }] });

await test('expandOverridePlugins adds the enabled-category rules of a plugin turned on only in an override', () => {
  const expanded = expandOverridePlugins(
    withVitest({ 'vitest/no-conditional-expect': 'allow', 'vitest/expect-expect': 'deny' }),
    CATALOG,
  );
  assert.deepEqual(expanded.overrides[0].rules, {
    'vitest/no-focused-tests': 'deny',
    'vitest/no-conditional-expect': 'allow',
    'vitest/no-conditional-in-test': 'warn',
    'vitest/expect-expect': 'deny',
  });
});

await test('diffConfigs sees a rule that a newer oxlint adds to an enabled category for an override plugin', () => {
  const before = expandOverridePlugins(withVitest({}), CATALOG);
  const after = expandOverridePlugins(withVitest({}), [
    ...CATALOG,
    { scope: 'vitest', value: 'require-to-throw-message', category: 'correctness' },
  ]);
  assert.deepEqual(kindsAndDetails(diffConfigs(before, after)), [
    'strengthened: override **/*.test.ts: vitest/require-to-throw-message: off → error',
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

const FAN_IN = {
  fanIn: [
    {
      workflow: '.github/workflows/e2e.yml',
      job: 'result',
      needs: ['plan', 'journeys'],
      checksResults: true,
      coversJobsExcept: ['nightly'],
      why: 'It reports every shard under one check name.',
    },
  ],
};

function gateWorkflow({ needs = ['plan', 'journeys'], condition = '${{ always() }}', reads = needs, extraJobs = {} } = {}) {
  const env = Object.fromEntries(reads.map((job) => [job.toUpperCase(), '${{ needs.' + job + '.result }}']));
  return stringify({
    jobs: {
      plan: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] },
      journeys: { needs: 'plan', 'runs-on': 'macos-15', steps: [{ run: 'true' }] },
      nightly: { 'runs-on': 'macos-15', steps: [{ run: 'true' }] },
      result: { needs, ...(condition === null ? {} : { if: condition }), 'runs-on': 'ubuntu-latest', steps: [{ env, run: 'test "$PLAN" = success' }] },
      ...extraJobs,
    },
  });
}

const fanIn = (text) =>
  checkFanIn(FAN_IN, (file) => (file === '.github/workflows/e2e.yml' ? text : undefined)).map(
    (finding) => `${finding.kind}${finding.job === undefined ? '' : `: ${finding.job}`}`,
  );

await test('checkFanIn passes a gate that waits for every job, runs after failures and reads each result', () => {
  assert.deepEqual(fanIn(gateWorkflow()), []);
  assert.deepEqual(fanIn(gateWorkflow({ condition: '${{ !cancelled() }}' })), []);
});

await test('checkFanIn flags a gate that stopped waiting for a collected job', () => {
  assert.deepEqual(fanIn(gateWorkflow({ needs: ['plan'] })), ['fan-in-need: journeys', 'fan-in-uncovered: journeys']);
});

await test('checkFanIn flags a gate that would be skipped, and so reported as passed, when a collected job fails', () => {
  assert.deepEqual(fanIn(gateWorkflow({ condition: null })), ['fan-in-condition']);
  assert.deepEqual(fanIn(gateWorkflow({ condition: '${{ success() }}' })), ['fan-in-condition']);
});

await test('checkFanIn flags a gate that waits for a job but never reads its result', () => {
  assert.deepEqual(fanIn(gateWorkflow({ reads: ['plan'] })), ['fan-in-result: journeys']);
});

await test('checkFanIn flags a new job in the workflow that the gate does not collect', () => {
  const extraJobs = { windows: { needs: 'plan', 'runs-on': 'windows-2025', steps: [{ run: 'true' }] } };
  assert.deepEqual(fanIn(gateWorkflow({ extraJobs })), ['fan-in-uncovered: windows']);
});

await test('checkFanIn flags a registered gate whose job or workflow is gone', () => {
  assert.deepEqual(fanIn(stringify({ jobs: { plan: { steps: [{ run: 'true' }] } } })), ['fan-in-missing']);
  assert.deepEqual(fanIn(undefined), ['fan-in-missing']);
});
