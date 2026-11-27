import assert from 'node:assert/strict';
import { test } from 'node:test';

import { failedJourneys, githubClient, nextStep, report, TITLE } from './report-main-journeys.mjs';

const shardLog = [
  '2026-11-20T04:50:31.3118870Z     Error Context: test-results/e2e/e2e-lifecycle-restore/error-context.md',
  '2026-11-20T04:50:31.3119430Z ',
  '2026-11-20T04:50:31.3119960Z   1 failed',
  '2026-11-20T04:50:31.3122970Z     [app-shell] › e2e/lifecycle-restore.spec.ts:52:1 › panels survive a relaunch ',
  '2026-11-20T04:50:31.3125590Z   77 passed (22.3m)',
  '2026-11-20T04:50:32.5344170Z /Users/runner/work/kimi-code/kimi-code/apps/desktop:',
].join('\n');

const colouredLog = [
  '\u001b[31m  2 failed\u001b[39m',
  '\u001b[31m    [turns-transcript] › e2e/turn-steer.spec.ts:10:3 › steers a running turn ─────────\u001b[39m',
  '\u001b[31m    [app-shell] › e2e/composer.spec.ts:5:1 › keeps the draft\u001b[39m',
  '\u001b[33m  1 interrupted\u001b[39m',
  '\u001b[33m    [app-shell] › e2e/slow.spec.ts:3:1 › waits for the reply\u001b[39m',
  '\u001b[33m  1 flaky\u001b[39m',
  '\u001b[33m    [app-shell] › e2e/flaky.spec.ts:1:1 › passes on the retry\u001b[39m',
  '\u001b[32m  70 passed\u001b[39m\u001b[2m (8.1m)\u001b[22m',
].join('\r\n');

await test('reads the failing and interrupted journeys from the Playwright summary, but not the flaky ones', () => {
  assert.deepEqual(failedJourneys(shardLog), ['[app-shell] › e2e/lifecycle-restore.spec.ts:52:1 › panels survive a relaunch']);
  assert.deepEqual(failedJourneys(colouredLog), [
    '[turns-transcript] › e2e/turn-steer.spec.ts:10:3 › steers a running turn',
    '[app-shell] › e2e/composer.spec.ts:5:1 › keeps the draft',
    '[app-shell] › e2e/slow.spec.ts:3:1 › waits for the reply',
  ]);
  assert.deepEqual(failedJourneys('2026-11-20T04:50:31Z   78 passed (22.3m)\n'), []);
});

await test('opens the tracking issue on the first failure, comments while it keeps failing, and closes it on a pass', () => {
  const issue = { number: 7 };
  assert.equal(nextStep('failure', undefined), 'open');
  assert.equal(nextStep('failure', issue), 'comment');
  assert.equal(nextStep('success', issue), 'close');
  assert.equal(nextStep('success', undefined), 'none');
  for (const result of ['cancelled', 'skipped', '']) {
    assert.equal(nextStep(result, issue), 'none');
    assert.equal(nextStep(result, undefined), 'none');
  }
});

function fakeClient({ issue, logs = [], lastPass, commits = [] } = {}) {
  const calls = [];
  return {
    calls,
    async findOpenIssue(title) { calls.push(['find', title]); return issue; },
    async failedShardLogs(runId, attempt) { calls.push(['logs', runId, attempt]); return logs; },
    async lastPassingRun(runId) { calls.push(['last-pass', runId]); return lastPass; },
    async commitsBetween(base, head) { calls.push(['commits', base, head]); return commits; },
    async openIssue(title, body) { calls.push(['open', title, body]); return 41; },
    async comment(number, body) { calls.push(['comment', number, body]); },
    async close(number) { calls.push(['close', number]); },
  };
}

const run = 'https://github.example.test/o/r/actions/runs/9';
const sha = 'bbbbbbbbbbbbbbbbbbbb';

await test('opens an issue that names the failing journeys and the commits since the last pass', async () => {
  const client = fakeClient({
    logs: [shardLog, colouredLog, shardLog],
    lastPass: { sha: 'aaaaaaaaaaaa', url: 'https://github.example.test/o/r/actions/runs/7' },
    commits: [{ sha: 'cccccccccccc', subject: 'feat: something (#1)' }],
  });
  assert.deepEqual(await report({ result: 'failure', run, sha, runId: '9', attempt: '2', client }), { step: 'open', issue: 41 });
  const [, title, body] = client.calls.find(call => call[0] === 'open');
  assert.equal(title, TITLE);
  assert.match(body, /Run: https:\/\/github\.example\.test\/o\/r\/actions\/runs\/9/);
  assert.match(body, /Commit: bbbbbbbbbbbbbbbbbbbb/);
  assert.equal(body.match(/lifecycle-restore\.spec\.ts:52:1/g).length, 1);
  assert.match(body, /- `\[app-shell\] › e2e\/slow\.spec\.ts:3:1 › waits for the reply`/);
  assert.doesNotMatch(body, /passes on the retry/);
  assert.match(body, /Commits since the last passing run \(https:\/\/github\.example\.test\/o\/r\/actions\/runs\/7, aaaaaaaaa\):\n- ccccccccc feat: something \(#1\)/);
  assert.match(body, /closes the issue when a later run on main passes/);
  assert.deepEqual(client.calls.filter(call => call[0] === 'logs' || call[0] === 'commits'), [['logs', '9', '2'], ['commits', 'aaaaaaaaaaaa', sha]]);
});

await test('says so when no journey failed or no run passed before', async () => {
  const client = fakeClient();
  await report({ result: 'failure', run, sha, runId: '9', attempt: '1', client });
  const [, , body] = client.calls.find(call => call[0] === 'open');
  assert.match(body, /The shards did not print any failing journey/);
  assert.match(body, /No earlier run of this workflow passed on main/);
  assert.equal(client.calls.some(call => call[0] === 'commits'), false);
});

await test('comments on the open issue while main keeps failing', async () => {
  const client = fakeClient({ issue: { number: 7 }, logs: [shardLog] });
  assert.deepEqual(await report({ result: 'failure', run, sha, runId: '9', attempt: '1', client }), { step: 'comment', issue: 7 });
  const [, number, body] = client.calls.find(call => call[0] === 'comment');
  assert.equal(number, 7);
  assert.match(body, /^Still failing\.\n\nRun: /);
  assert.match(body, /lifecycle-restore\.spec\.ts/);
  assert.equal(client.calls.some(call => call[0] === 'open' || call[0] === 'close'), false);
});

await test('closes the open issue with a link to the passing run', async () => {
  const client = fakeClient({ issue: { number: 7 } });
  assert.deepEqual(await report({ result: 'success', run, sha, runId: '9', attempt: '1', client }), { step: 'close', issue: 7 });
  assert.deepEqual(client.calls.slice(1), [
    ['comment', 7, `The Desktop E2E journeys pass on main again: ${run} (commit bbbbbbbbb). Closing this issue.`],
    ['close', 7],
  ]);
});

await test('leaves the issues alone when main passes without an open issue, or the run did not finish', async () => {
  for (const [result, issue] of [['success', undefined], ['cancelled', { number: 7 }], ['skipped', undefined]]) {
    const client = fakeClient({ issue });
    assert.deepEqual(await report({ result, run, sha, runId: '9', attempt: '1', client }), { step: 'none' });
    assert.deepEqual(client.calls, [['find', TITLE]]);
  }
});

await test('reads and writes through the REST API with the token', async () => {
  const responses = new Map([
    ['GET repos/o/r/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100', [{ number: 1, title: 'Other' }, { number: 2, title: TITLE, pull_request: {} }, { number: 3, title: TITLE }]],
    ['GET repos/o/r/actions/runs/9/attempts/2/jobs?per_page=100', {
      jobs: [
        { id: 11, name: 'Desktop E2E shard 1/5', conclusion: 'failure' },
        { id: 12, name: 'Desktop E2E shard 2/5', conclusion: 'success' },
        { id: 13, name: 'Plan the desktop journeys', conclusion: 'failure' },
      ],
    }],
    ['GET repos/o/r/actions/jobs/11/logs', 'raw log of shard 1'],
    ['GET repos/o/r/actions/workflows/desktop-e2e.yml/runs?branch=main&status=success&per_page=20', {
      workflow_runs: [
        { id: 9, event: 'push', head_sha: 'current', html_url: 'run-9' },
        { id: 8, event: 'workflow_dispatch', head_sha: 'manual', html_url: 'run-8' },
        { id: 7, event: 'schedule', head_sha: 'aaa', html_url: 'run-7' },
      ],
    }],
    ['GET repos/o/r/compare/aaa...bbb', { commits: [{ sha: 'c1', commit: { message: 'fix: one\n\nmore detail' } }] }],
    ['POST repos/o/r/issues', { number: 5 }],
    ['POST repos/o/r/issues/5/comments', {}],
    ['PATCH repos/o/r/issues/5', {}],
  ]);
  const requests = [];
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${url.replace('https://api.example.test/', '')}`;
    requests.push({ key, init });
    if (!responses.has(key)) return new Response('Not Found', { status: 404 });
    const value = responses.get(key);
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
  };
  const client = githubClient({ token: 'YOUR_TOKEN', repo: 'o/r', apiUrl: 'https://api.example.test', fetchImpl });
  assert.equal((await client.findOpenIssue(TITLE)).number, 3);
  assert.deepEqual(await client.failedShardLogs('9', '2'), ['raw log of shard 1']);
  assert.deepEqual(await client.lastPassingRun('9'), { sha: 'aaa', url: 'run-7', event: 'schedule' });
  assert.deepEqual(await client.commitsBetween('aaa', 'bbb'), [{ sha: 'c1', subject: 'fix: one' }]);
  assert.equal(await client.openIssue(TITLE, 'body'), 5);
  await client.comment(5, 'hello');
  await client.close(5);
  assert.ok(requests.every(request => request.init.headers.Authorization === 'Bearer YOUR_TOKEN'));
  assert.deepEqual(JSON.parse(requests.find(request => request.key === 'POST repos/o/r/issues').init.body), { title: TITLE, body: 'body' });
  assert.deepEqual(JSON.parse(requests.find(request => request.key === 'POST repos/o/r/issues/5/comments').init.body), { body: 'hello' });
  assert.deepEqual(JSON.parse(requests.find(request => request.key === 'PATCH repos/o/r/issues/5').init.body), { state: 'closed', state_reason: 'completed' });
  await assert.rejects(client.commitsBetween('x', 'y'), /GET repos\/o\/r\/compare\/x\.\.\.y failed with HTTP 404: Not Found/);
});
