import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalogProblems, readCatalog } from './e2e-cache-catalog.mjs';

const KEEPS_SPEC = 'tests/e2e/scenarios/cache/restart-keeps-the-prefix.spec.ts';
const BREAKS_SPEC = 'tests/e2e/scenarios/cache/undo-breaks-the-history.spec.ts';
const KAP = 'tests/scenarios/prompt-cache.test.ts';
const files = {
  [KEEPS_SPEC]: "scenario('keeps the prefix', {}, async () => {});",
  [BREAKS_SPEC]: "model.expectCacheBreak('the user withdrew the last prompt', { at: 'history' });",
  [KAP]: "describe('a session turning plan mode on', () => {});",
  'tests/e2e/scenarios/approval/reject-keeps-file.spec.ts': "scenario('rejects', {}, async () => {});",
};
const readText = (file) => files[file];
const keeps = { id: 'A1', operation: 'Restart and continue', promise: 'keeps', coverage: [{ kind: 'explicit', test: KEEPS_SPEC }] };
const breaks = {
  id: 'A5',
  operation: 'Undo the last prompt',
  promise: 'breaks',
  break: { at: 'history', reason: 'the user withdrew the last prompt' },
  coverage: [{ kind: 'explicit', test: BREAKS_SPEC }],
};
const check = (entries, scenarios = [KEEPS_SPEC, BREAKS_SPEC]) => catalogProblems({ entries, scenarios, readText });

await test('accepts covered entries of every kind and entries that only record a gap', () => {
  assert.deepEqual(
    check([
      keeps,
      breaks,
      { id: 'B2', operation: 'Plan mode', promise: 'keeps', coverage: [{ kind: 'kap', test: KAP, case: 'turning plan mode on' }], gap: 'Needs a plan mode action.' },
      { id: 'D1', operation: 'Reject', promise: 'keeps', coverage: [{ kind: 'implicit', test: 'tests/e2e/scenarios/approval/reject-keeps-file.spec.ts' }] },
      { id: 'B7', operation: 'Add a directory', promise: 'unknown', gap: 'Find out what the product does.' },
    ]),
    [],
  );
});

await test('reads the entries list and rejects a catalog without one', () => {
  assert.deepEqual(readCatalog('entries:\n  - id: A1\n').entries, [{ id: 'A1' }]);
  assert.deepEqual(readCatalog('items: []\n').problems, ['tests/e2e/scenarios/cache/catalog.yaml must have an entries list']);
});

await test('requires an id, an operation, a promise and either coverage or a gap', () => {
  assert.deepEqual(check([{ id: 'X1', promise: 'maybe' }], []), [
    'X1: id must be a group letter A-F followed by a number',
    'X1: operation must say what the user does or what happens',
    'X1: promise must be one of keeps, breaks, unknown',
    'X1: list the tests that cover it, or say in gap what is missing',
  ]);
});

await test('requires where and why a break happens, and only for a promise of breaks', () => {
  assert.deepEqual(check([keeps, { ...breaks, break: { at: 'tools' } }]), [
    'A5: a break needs break.at (header or history) and break.reason, the reason the scenario declares with model.expectCacheBreak()',
  ]);
  assert.deepEqual(check([{ ...keeps, break: { at: 'history', reason: 'no' } }, breaks]), ['A1: only a promise of breaks takes a break']);
});

await test('ties explicit coverage to what the cache scenario declares', () => {
  assert.deepEqual(check([{ ...keeps, coverage: [{ kind: 'explicit', test: BREAKS_SPEC }] }, { ...breaks, coverage: [{ kind: 'explicit', test: KEEPS_SPEC }] }]), [
    'A1: tests/e2e/scenarios/cache/undo-breaks-the-history.spec.ts declares a cache break, but the promise is keeps',
    'A5: tests/e2e/scenarios/cache/restart-keeps-the-prefix.spec.ts must declare the break with model.expectCacheBreak("the user withdrew the last prompt", …)',
  ]);
});

await test('puts each kind of coverage in its own place and requires the file and the case to exist', () => {
  assert.deepEqual(
    check([
      keeps,
      breaks,
      {
        id: 'D2',
        operation: 'Answer',
        promise: 'keeps',
        coverage: [
          { kind: 'explicit', test: 'tests/e2e/scenarios/approval/reject-keeps-file.spec.ts' },
          { kind: 'implicit', test: KEEPS_SPEC },
          { kind: 'kap', test: 'tests/scenarios/missing.test.ts' },
          { kind: 'kap', test: KAP, case: 'turning swarm mode on' },
          { kind: 'unit', test: KAP },
        ],
      },
    ]),
    [
      'D2: explicit coverage must point at a scenario in tests/e2e/scenarios/cache/, got "tests/e2e/scenarios/approval/reject-keeps-file.spec.ts"',
      'D2: implicit coverage must point at a scenario in tests/e2e/scenarios/ outside tests/e2e/scenarios/cache/, got "tests/e2e/scenarios/cache/restart-keeps-the-prefix.spec.ts"',
      'D2: tests/scenarios/missing.test.ts does not exist',
      'D2: tests/scenarios/prompt-cache.test.ts has no case "turning swarm mode on"',
      'D2: coverage kind must be one of explicit, implicit, kap, engine',
    ],
  );
});

await test('keeps an unknown promise out of cache scenarios', () => {
  assert.deepEqual(check([keeps, breaks, { id: 'C5', operation: 'Browser control', promise: 'unknown', coverage: [{ kind: 'explicit', test: KEEPS_SPEC }] }]), [
    'C5: an unknown promise needs a gap that says what to find out',
    'C5: a scenario cannot assert an unknown promise; settle the promise first',
  ]);
});

await test('requires every cache scenario to be listed and every id to be unique', () => {
  assert.deepEqual(check([keeps, { ...keeps, coverage: [{ kind: 'explicit', test: KEEPS_SPEC }] }]), [
    'A1 is listed twice',
    'tests/e2e/scenarios/cache/undo-breaks-the-history.spec.ts is a cache scenario, but no entry in tests/e2e/scenarios/cache/catalog.yaml lists it as explicit coverage',
  ]);
});
