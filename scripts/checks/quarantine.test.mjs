import assert from 'node:assert/strict';
import { test } from 'node:test';

import { quarantinedTests, quarantineProblems, readQuarantine } from './quarantine.mjs';

const journey = 'apps/desktop/e2e/sample.spec.ts';
const entry = {
  file: journey,
  test: 'a flaky journey',
  runner: 'playwright',
  reason: 'reproduced on main',
  owner: '@owner',
  since: '2026-11-19',
  expires: '2027-01-10',
};
const found = [{ file: journey, test: 'a flaky journey', smoke: false }];
const check = (overrides = {}) => quarantineProblems({ entries: [entry], found, protectedIds: ['desktop.first-turn'], today: '2026-11-20', ...overrides });

await test('reads one-line quarantined Desktop declarations and refuses markers it cannot read', () => {
  const { found: tests, problems } = quarantinedTests([
    { file: journey, text: "test('a flaky journey', { tag: '@quarantine' }, async () => {});\ntest('a steady one', async () => {});" },
    { file: 'apps/desktop/test/e2e/area/more.spec.ts', text: "test(\"it\\'s tagged\", { tag: ['@slow', '@quarantine'] }, async () => {});" },
    { file: 'apps/desktop/e2e/split.spec.ts', text: "test(\n  'split title',\n  { tag: '@quarantine' },\n  async () => {},\n);" },
    { file: 'packages/kap-server/test/sessions.test.ts', text: "it('x', { tags: ['@quarantine'] }, () => {});" },
    { file: 'apps/desktop/e2e/smoke.spec.ts', text: "test('[L0:desktop.first-turn] first turn', { tag: ['@smoke', '@quarantine'] }, async () => {});" },
  ]);
  assert.deepEqual(tests, [
    { file: journey, test: 'a flaky journey', smoke: false },
    { file: 'apps/desktop/test/e2e/area/more.spec.ts', test: "it's tagged", smoke: false },
    { file: 'apps/desktop/e2e/smoke.spec.ts', test: '[L0:desktop.first-turn] first turn', smoke: true },
  ]);
  assert.deepEqual(problems, [
    "apps/desktop/e2e/split.spec.ts marks 1 test(s) with @quarantine but declares 0 on one line as test('title', { tag: '@quarantine' }, ...)",
    'packages/kap-server/test/sessions.test.ts uses @quarantine, but only Desktop journeys can be quarantined',
  ]);
});

await test('requires every field of a quarantine entry', () => {
  const { entries, problems } = readQuarantine(`quarantine:\n  - file: ${journey}\n    test: a flaky journey\n    runner: playwright\n    reason: ''\n    since: '2026-11-19'\n    expires: '2027-01-10'\n`);
  assert.deepEqual(entries, []);
  assert.deepEqual(problems, ['tests/quarantine.yaml entry 1 lacks reason, owner']);
  assert.deepEqual(readQuarantine('other: []\n').problems, ['tests/quarantine.yaml must have a quarantine list']);
});

await test('accepts a registered journey that has not expired', () => {
  assert.deepEqual(check(), []);
});

await test('ties quarantined tests and entries to each other', () => {
  assert.deepEqual(check({ entries: [] }), [`${journey} › a flaky journey is tagged @quarantine but not listed in tests/quarantine.yaml; add its reason, owner, since and expires`]);
  assert.deepEqual(check({ found: [] }), [`${journey} › a flaky journey is listed in tests/quarantine.yaml, but no test with that title in that file is tagged @quarantine`]);
  assert.deepEqual(check({ entries: [entry, entry] }), [`${journey} › a flaky journey is listed twice`]);
  assert.match(check({ entries: [{ ...entry, runner: 'vitest' }] }).join('\n'), /runner vitest is not supported/);
});

await test('checks the dates against the commit date', () => {
  assert.deepEqual(check({ today: '2027-01-11' }), [`${journey} › a flaky journey expired on 2027-01-10: fix the journey and drop the tag, or renew it with a new expires date and reason`]);
  assert.deepEqual(check({ today: '2027-01-10' }), []);
  assert.match(check({ entries: [{ ...entry, expires: '2027-01-20' }] }).join('\n'), /more than 60 days after the commit date 2026-11-20/);
  assert.match(check({ entries: [{ ...entry, since: '2026-11-21' }] }).join('\n'), /since 2026-11-21 is later than the commit date/);
  assert.match(check({ entries: [{ ...entry, expires: '2026-11-19' }] }).join('\n'), /must be after since/);
  assert.match(check({ entries: [{ ...entry, expires: '2027-02-30' }] }).join('\n'), /must be dates written as YYYY-MM-DD/);
});

await test('never quarantines a protected or smoke journey', () => {
  const l0 = { file: journey, test: '[L0:desktop.first-turn] first turn', smoke: true };
  const problems = check({ entries: [{ ...entry, test: l0.test }], found: [l0] });
  assert.ok(problems.some((problem) => problem.includes('is a smoke journey')), problems.join('\n'));
  assert.ok(problems.some((problem) => problem.includes('is a protected L0 test and cannot be quarantined')), problems.join('\n'));
});
