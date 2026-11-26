import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareCounts } from './ratchet.mjs';
import { countFixedWaits, formatReport, isCheckedFile, timerPromiseNames } from './fixed-waits.mjs';

const FILE = 'packages/agent-core-v2/test/agent/loop/loop.test.ts';

function countIn(text) {
  return countFixedWaits([{ file: FILE, text }]);
}

await test('isCheckedFile looks at test sources and skips the checks themselves', () => {
  assert.equal(isCheckedFile(FILE), true);
  assert.equal(isCheckedFile('apps/desktop/e2e/core-turn.spec.ts'), true);
  assert.equal(isCheckedFile('packages/testkit/test/model.test.ts'), true);
  assert.equal(isCheckedFile('packages/kap-server/src/server.ts'), false);
  assert.equal(isCheckedFile('scripts/checks/fixed-waits.test.mjs'), false);
  assert.equal(isCheckedFile('packages/klient/node_modules/x/test/a.test.ts'), false);
});

await test('a promise resolved by a timer counts in its common spellings', () => {
  assert.deepEqual(
    countIn(
      [
        'await new Promise((resolve) => setTimeout(resolve, 10));',
        'await new Promise<void>((resolve) => { setTimeout(resolve, 0); });',
        'await new Promise((r) => setTimeout(r, 50));',
        'await new Promise((resolve) => setTimeout(() => resolve(), 25));',
        'await new Promise((resolve) => setImmediate(resolve));',
      ].join('\n'),
    ),
    { 'promise-timer': { [FILE]: 5 } },
  );
});

await test('timers that do not resolve a waiting promise do not count', () => {
  assert.deepEqual(
    countIn(
      [
        'setTimeout(() => controller.abort(), 10);',
        'const timer = setTimeout(callback, 0);',
        'vi.advanceTimersByTime(1000);',
        'await vi.waitFor(() => expect(done).toBe(true));',
        "new Promise((resolve) => { emitter.once('ready', resolve); });",
      ].join('\n'),
    ),
    {},
  );
});

await test('timers from node:timers/promises count under the name they were imported as', () => {
  const text = [
    "import { setTimeout as delay, setImmediate } from 'node:timers/promises';",
    "import { setInterval } from 'timers/promises';",
    'await delay(10);',
    'await setImmediate();',
    'for await (const _ of setInterval(5)) break;',
  ].join('\n');
  assert.deepEqual(timerPromiseNames(text), ['delay', 'setImmediate']);
  assert.deepEqual(countIn(text), { 'timers-promises': { [FILE]: 2 } });
});

await test("Playwright's waitForTimeout counts", () => {
  assert.deepEqual(countFixedWaits([{ file: 'apps/desktop/e2e/a.spec.ts', text: 'await page.waitForTimeout(500);' }]), {
    'wait-for-timeout': { 'apps/desktop/e2e/a.spec.ts': 1 },
  });
});

await test('a new fixed wait fails with the signal-based alternative, and a removed one asks to lower the baseline', () => {
  const baseline = { 'promise-timer': { [FILE]: 2 } };
  const added = formatReport(compareCounts(baseline, { 'promise-timer': { [FILE]: 3 } })).join('\n');
  assert.match(added, /promise-timer in packages\/agent-core-v2\/test\/agent\/loop\/loop\.test\.ts: 2 → 3/);
  assert.match(added, /instead: wait for a signal instead/);
  const removed = formatReport(compareCounts(baseline, {})).join('\n');
  assert.match(removed, /allows more fixed waits than the tests use/);
  assert.deepEqual(formatReport(compareCounts(baseline, baseline)), []);
});
