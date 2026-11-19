import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareCounts, countFindings, ratchetRules, ruleOf } from './ratchet.mjs';

await test('ruleOf turns an oxlint diagnostic code into the config rule name', () => {
  assert.equal(ruleOf('typescript(no-explicit-any)'), 'typescript/no-explicit-any');
  assert.equal(ruleOf('eslint(no-empty)'), 'eslint/no-empty');
  assert.equal(ruleOf('react-hooks(exhaustive-deps)'), 'react/exhaustive-deps');
  assert.equal(ruleOf(undefined), undefined);
  assert.equal(ruleOf(''), undefined);
});

await test('ratchetRules collects the rules that a config turns on at the root and in overrides', () => {
  const rules = ratchetRules({
    rules: { 'eslint/no-empty': 'error', 'eslint/no-console': 'off' },
    overrides: [
      { rules: { 'eslint/no-console': 'error', 'vitest/valid-title': 'allow' } },
      { rules: { 'typescript/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: false }] } },
    ],
  });
  assert.deepEqual(
    rules,
    new Set(['eslint/no-console', 'eslint/no-empty', 'typescript/switch-exhaustiveness-check']),
  );
});

const UNUSED = {
  message: 'Unused oxlint-disable directive (no problems were reported).',
  filename: 'packages/core/src/a.ts',
};

await test('countFindings counts frozen rules per file and keeps unused directives and unmatched findings apart', () => {
  const NOT_FROZEN = { code: 'eslint(eqeqeq)', message: 'Expected ===.', filename: 'packages/core/src/a.ts' };
  const NO_CODE = { message: 'Expected a semicolon.', filename: 'packages/core/src/c.ts' };
  const { counts, unused, unmatched } = countFindings(
    [
      { code: 'eslint(no-empty)', message: 'Unexpected empty block.', filename: 'packages/core/src/a.ts' },
      { code: 'eslint(no-empty)', message: 'Unexpected empty block.', filename: 'packages/core/src/a.ts' },
      { code: 'eslint(no-empty)', message: 'Unexpected empty block.', filename: 'packages/core/src/b.ts' },
      { code: 'react-hooks(exhaustive-deps)', message: 'Missing dependency.', filename: 'apps/vis/web/src/a.tsx' },
      NOT_FROZEN,
      NO_CODE,
      UNUSED,
    ],
    new Set(['eslint/no-empty', 'react/exhaustive-deps']),
  );
  assert.deepEqual(counts, {
    'eslint/no-empty': { 'packages/core/src/a.ts': 2, 'packages/core/src/b.ts': 1 },
    'react/exhaustive-deps': { 'apps/vis/web/src/a.tsx': 1 },
  });
  assert.deepEqual(unused, [UNUSED]);
  assert.deepEqual(unmatched, [NOT_FROZEN, NO_CODE]);
});

const describeChange = (change) => `${change.kind} ${change.rule} ${change.file} ${change.from}→${change.to}`;

await test('compareCounts reports nothing when every file holds its count', () => {
  const counts = { 'eslint/no-empty': { 'a.ts': 2 } };
  assert.deepEqual(compareCounts(counts, structuredClone(counts)), []);
});

await test('compareCounts reports a file that gains findings, including a file the baseline does not list', () => {
  const changes = compareCounts(
    { 'eslint/no-empty': { 'a.ts': 2 } },
    { 'eslint/no-empty': { 'a.ts': 3, 'b.ts': 1 } },
  );
  assert.deepEqual(changes.map(describeChange), [
    'added eslint/no-empty a.ts 2→3',
    'added eslint/no-empty b.ts 0→1',
  ]);
});

await test('compareCounts reports fixed findings and rules that left the ratchet so the baseline shrinks', () => {
  const changes = compareCounts(
    { 'eslint/no-empty': { 'a.ts': 2 }, 'unicorn/no-array-sort': { 'c.ts': 1 } },
    { 'eslint/no-empty': { 'a.ts': 1 } },
  );
  assert.deepEqual(changes.map(describeChange), [
    'removed eslint/no-empty a.ts 2→1',
    'removed unicorn/no-array-sort c.ts 1→0',
  ]);
});

await test('compareCounts lists new findings before stale ones', () => {
  const changes = compareCounts(
    { 'eslint/no-empty': { 'b.ts': 1 } },
    { 'eslint/no-empty': { 'a.ts': 1 } },
  );
  assert.deepEqual(changes.map((change) => change.kind), ['added', 'removed']);
});
