import assert from 'node:assert/strict';
import { test } from 'node:test';

import { playwrightArgs, repeatsIn, rerunFailures, titleGrep } from './e2e-rerun-failures.mjs';

function failure(projectName, title, file = 'scenarios/conversation/example.spec.ts') {
  return { project: projectName.toUpperCase(), projectName, file, title, status: 'failed', note: 'expect(received).toEqual(expected)' };
}

function grepped(pattern) {
  const [, source, flags] = /^\/(.*)\/([gi]*)$/.exec(pattern);
  return new RegExp(source, flags);
}

function report(entries, errors = []) {
  const files = new Map();
  for (const { file, title, projectName, statuses } of entries) {
    const specs = files.get(file) ?? [];
    files.set(file, specs);
    let spec = specs.find(candidate => candidate.title === title);
    if (spec === undefined) {
      spec = { title, file: 'support/scenario.ts', tests: [] };
      specs.push(spec);
    }
    spec.tests.push(...statuses.map(status => ({ projectName, results: status === undefined ? [] : [{ status }] })));
  }
  return { suites: [...files].map(([file, specs]) => ({ title: file, file, specs })), errors };
}

const steady = failure('tui', 'keeps the draft after a restart');
const flaky = failure('tui-kitty', 'answers a question (twice)', 'scenarios/question/answer.spec.ts');

await test('selects exactly one case by project, file and title, the way Playwright joins them for --grep, on either path separator', () => {
  const pattern = grepped(titleGrep(flaky));
  assert.equal(pattern.flags, '');
  assert.equal(pattern.test('tui-kitty scenarios/question/answer.spec.ts answers a question (twice)'), true);
  assert.equal(pattern.test(String.raw`tui-kitty scenarios\question\answer.spec.ts answers a question (twice)`), true);
  for (const other of [
    'tui scenarios/question/answer.spec.ts answers a question (twice)',
    'tui-kitty scenarios/question/answer.spec.ts answers a question (twice) and more',
    'tui-kitty scenarios/question/answer.spec.ts also answers a question (twice)',
    'tui-kitty scenarios/question/answerXspec.ts answers a question (twice)',
    'tui-kitty scenarios/question/answer.spec.ts Answers a question (twice)',
    'tui-kitty scenarios/question/answer.spec.ts answers a question twice',
  ]) {
    assert.equal(pattern.test(other), false, other);
  }
});

await test('escapes every character a title may share with regular expressions', () => {
  const title = String.raw`runs "a|b" with [x] {1,2} ^$ \ / ? * + . (done)`;
  const pattern = grepped(titleGrep(failure('acp', title)));
  assert.equal(pattern.test(`acp scenarios/conversation/example.spec.ts ${title}`), true);
  assert.equal(pattern.test('acp scenarios/conversation/example.spec.ts runs "a" with x 1 done'), false);
});

await test('reruns one case in its own project and file, five times, within its share of the time, without touching the suite\'s report or output', () => {
  const args = playwrightArgs({ failure: flaky, repeats: 5, timeout: 200_000, output: '/tmp/e2e-rerun-1/test-results' });
  assert.deepEqual(args, [
    'test',
    String.raw`scenarios[\\/]question[\\/]answer\.spec\.ts$`,
    '--project=tui-kitty',
    `--grep=${titleGrep(flaky)}`,
    '--repeat-each=5',
    '--global-timeout=200000',
    '--reporter=list,json',
    '--output=/tmp/e2e-rerun-1/test-results',
  ]);
  assert.equal(new RegExp(args[1], 'gi').test('/home/runner/work/kimi-code/kimi-code/tests/e2e/scenarios/question/answer.spec.ts'), true);
  assert.equal(new RegExp(args[1], 'gi').test('D:/a/kimi-code/kimi-code/tests/e2e/scenarios/question/answer.spec.ts'), true);
  assert.equal(new RegExp(args[1], 'gi').test(String.raw`D:\a\kimi-code\kimi-code\tests\e2e\scenarios\question\answer.spec.ts`), true);
  assert.equal(new RegExp(args[1], 'gi').test('/home/runner/work/kimi-code/kimi-code/tests/e2e/scenarios/question/other.spec.ts'), false);
  assert.equal(args.some(arg => arg.startsWith('--retries') || arg.startsWith('--last-failed') || arg.startsWith('--shard')), false);
});

await test('counts failed and timed-out repeats as reproduced, passes as passed, and the rest as unfinished', () => {
  const json = report([
    { file: steady.file, title: steady.title, projectName: 'tui', statuses: ['failed', 'timedOut', 'failed', 'failed', 'failed'] },
    { file: steady.file, title: steady.title, projectName: 'tui-kitty', statuses: ['passed', 'passed', 'passed', 'passed', 'passed'] },
    { file: flaky.file, title: flaky.title, projectName: 'tui-kitty', statuses: ['passed', 'failed', 'interrupted', undefined, undefined] },
  ]);
  assert.deepEqual(repeatsIn(json, steady, 5), { failed: 5, passed: 0, unfinished: 0 });
  assert.deepEqual(repeatsIn(json, flaky, 5), { failed: 1, passed: 1, unfinished: 3 });
});

await test('fails loudly when Playwright did not select the case, naming the error it reported', () => {
  const json = report([{ file: steady.file, title: steady.title, projectName: 'tui-kitty', statuses: ['passed'] }], [{ message: 'Error: No tests found\nmore' }]);
  assert.throws(() => repeatsIn(json, steady, 5), /^Error: Playwright did not select the case: Error: No tests found$/);
  assert.throws(() => repeatsIn({ suites: [] }, steady, 5), /^Error: Playwright did not select the case$/);
});

function clock(start = 0) {
  let time = start;
  return { now: () => time, advance: milliseconds => (time += milliseconds) };
}

await test('reruns the first cases one after another, splitting what is left of the time among the cases still to run, and saves after each', () => {
  const time = clock();
  const calls = [];
  const saved = [];
  const third = failure('acp', 'edits a file');
  const fourth = failure('acp', 'runs a command');
  const outcomes = [
    ['failed', 'failed', 'failed', 'failed', 'failed'],
    ['passed', 'failed', 'passed', 'passed', 'passed'],
    ['passed', 'passed', 'passed', 'passed', 'passed'],
  ];
  const results = { platform: 'linux', shard: null, status: 'failed', errors: [], failures: [steady, flaky, third, fourth] };
  const before = structuredClone(results);
  const rerun = rerunFailures({
    results,
    now: time.now,
    budget: 900,
    save: current => saved.push(structuredClone(current)),
    runCase: ({ failure: chosen, repeats, timeout }) => {
      calls.push([chosen.title, repeats, timeout]);
      time.advance(calls.length === 1 ? 100 : 400);
      return report([{ file: chosen.file, title: chosen.title, projectName: chosen.projectName, statuses: outcomes[calls.length - 1] }]);
    },
  });
  assert.deepEqual(calls, [
    [steady.title, 5, 300],
    [flaky.title, 5, 400],
    [third.title, 5, 400],
  ]);
  assert.deepEqual(rerun.rerun, { repeats: 5, most: 3 });
  assert.deepEqual(
    rerun.failures.map(entry => entry.rerun),
    [{ failed: 5, passed: 0, unfinished: 0 }, { failed: 1, passed: 4, unfinished: 0 }, { failed: 0, passed: 5, unfinished: 0 }, undefined],
  );
  assert.deepEqual(rerun.failures[3], fourth);
  assert.equal(saved.length, 4);
  assert.deepEqual(
    saved[0].failures.map(entry => entry.rerun),
    [{ failed: 0, passed: 0, unfinished: 5 }, { failed: 0, passed: 0, unfinished: 5 }, { failed: 0, passed: 0, unfinished: 5 }, undefined],
  );
  assert.deepEqual(saved.at(-1), rerun);
  assert.deepEqual(results, before);
  assert.deepEqual(
    rerun.failures.map(entry => [entry.projectName, entry.file, entry.title, entry.status, entry.note]),
    before.failures.map(entry => [entry.projectName, entry.file, entry.title, entry.status, entry.note]),
  );
  assert.deepEqual([rerun.platform, rerun.shard, rerun.status, rerun.errors], ['linux', null, 'failed', []]);
});

await test('leaves the remaining cases marked unfinished once the time is used up', () => {
  const time = clock();
  const calls = [];
  const rerun = rerunFailures({
    results: { platform: 'linux', shard: null, status: 'failed', errors: [], failures: [steady, flaky] },
    now: time.now,
    budget: 1000,
    save: () => {},
    runCase: ({ failure: chosen }) => {
      calls.push(chosen.title);
      time.advance(1000);
      return report([{ file: chosen.file, title: chosen.title, projectName: chosen.projectName, statuses: ['failed', 'failed', undefined, undefined, undefined] }]);
    },
  });
  assert.deepEqual(calls, [steady.title]);
  assert.deepEqual(rerun.failures.map(entry => entry.rerun), [{ failed: 2, passed: 0, unfinished: 3 }, { failed: 0, passed: 0, unfinished: 5 }]);
});

await test('records why a case could not be rerun and goes on with the next one', () => {
  const legacy = { project: 'ACP', file: steady.file, title: 'written before the project name was recorded', status: 'failed', note: '' };
  const calls = [];
  const rerun = rerunFailures({
    results: { platform: 'win32', shard: { current: 1, total: 2 }, status: 'failed', errors: [], failures: [legacy, steady, flaky] },
    save: () => {},
    runCase: ({ failure: chosen }) => {
      calls.push(chosen.title);
      if (chosen.title === steady.title) throw new Error('Playwright ended with 1 without writing its JSON report');
      return report([{ file: chosen.file, title: chosen.title, projectName: chosen.projectName, statuses: ['passed', 'passed', 'passed', 'passed', 'passed'] }]);
    },
  });
  assert.deepEqual(rerun.failures.map(entry => entry.rerun), [
    { failed: 0, passed: 0, unfinished: 5, error: 'the results file does not name the Playwright project of this case' },
    { failed: 0, passed: 0, unfinished: 5, error: 'Playwright ended with 1 without writing its JSON report' },
    { failed: 0, passed: 5, unfinished: 0 },
  ]);
  assert.deepEqual(calls, [steady.title, flaky.title]);
});
