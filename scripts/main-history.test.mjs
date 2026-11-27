import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commitsBetween, lastPassingRun } from './main-history.mjs';

function answering(responses) {
  const asked = [];
  const get = async path => {
    asked.push(path);
    if (!responses.has(path)) throw new Error(`GET ${path} failed with HTTP 404: Not Found`);
    return responses.get(path);
  };
  return { asked, get };
}

const runs = [
  { id: 9, event: 'push', head_sha: 'current', html_url: 'run-9' },
  { id: 8, event: 'workflow_dispatch', head_sha: 'manual', html_url: 'run-8' },
  { id: 7, event: 'schedule', head_sha: 'nightly', html_url: 'run-7' },
  { id: 6, event: 'push', head_sha: 'merged', html_url: 'run-6' },
];

await test('finds the newest passing push or nightly run on main other than the current one, skipping manual runs', async () => {
  const { asked, get } = answering(new Map([['repos/o/r/actions/workflows/e2e.yml/runs?branch=main&status=success&per_page=20', { workflow_runs: runs }]]));
  assert.deepEqual(await lastPassingRun({ get, repo: 'o/r', workflow: 'e2e.yml', events: ['push', 'schedule'], currentRunId: '9' }), { sha: 'nightly', url: 'run-7', event: 'schedule' });
  assert.deepEqual(await lastPassingRun({ get, repo: 'o/r', workflow: 'e2e.yml', events: ['push', 'schedule'], currentRunId: 1 }), { sha: 'current', url: 'run-9', event: 'push' });
  assert.equal(asked.length, 2);
});

await test('asks GitHub for that one event when only one counts, so many newer pushes cannot hide the last nightly run', async () => {
  const path = 'repos/o/r/actions/workflows/e2e.yml/runs?branch=main&status=success&per_page=20&event=schedule';
  const { get } = answering(new Map([[path, { workflow_runs: [runs[2]] }]]));
  assert.deepEqual(await lastPassingRun({ get, repo: 'o/r', workflow: 'e2e.yml', events: ['schedule'], currentRunId: '9' }), { sha: 'nightly', url: 'run-7', event: 'schedule' });
});

await test('only looks at runs created before a given time, so a later pass on a newer commit is not taken as the base', async () => {
  const path = `repos/o/r/actions/workflows/427/runs?branch=main&status=success&per_page=20&created=${encodeURIComponent('<2026-11-26T20:15:49Z')}`;
  const { get } = answering(new Map([[path, { workflow_runs: [runs[3]] }]]));
  assert.deepEqual(
    await lastPassingRun({ get, repo: 'o/r', workflow: 427, events: ['push', 'schedule'], currentRunId: '10', createdBefore: '2026-11-26T20:15:49Z' }),
    { sha: 'merged', url: 'run-6', event: 'push' },
  );
});

await test('says there is no base when no earlier run of those events passed', async () => {
  const { get } = answering(new Map([['repos/o/r/actions/workflows/e2e.yml/runs?branch=main&status=success&per_page=20', { workflow_runs: [runs[0], runs[1]] }]]));
  assert.equal(await lastPassingRun({ get, repo: 'o/r', workflow: 'e2e.yml', events: ['push', 'schedule'], currentRunId: '9' }), undefined);
});

await test('lists the commits between two shas with their first line, and how many there are in all', async () => {
  const { get } = answering(
    new Map([
      [
        'repos/o/r/compare/aaa...bbb',
        {
          status: 'ahead',
          total_commits: 300,
          commits: [
            { sha: 'c1', commit: { message: 'fix: one (#11)\n\nmore detail' } },
            { sha: 'c2', commit: { message: 'feat: two' } },
          ],
        },
      ],
      ['repos/o/r/compare/bbb...bbb', { status: 'identical', total_commits: 0, commits: [] }],
      ['repos/o/r/compare/old...new', { commits: [{ sha: 'c3', commit: { message: 'docs: three' } }] }],
    ]),
  );
  assert.deepEqual(await commitsBetween({ get, repo: 'o/r', base: 'aaa', head: 'bbb' }), {
    status: 'ahead',
    total: 300,
    commits: [
      { sha: 'c1', subject: 'fix: one (#11)' },
      { sha: 'c2', subject: 'feat: two' },
    ],
  });
  assert.deepEqual(await commitsBetween({ get, repo: 'o/r', base: 'bbb', head: 'bbb' }), { status: 'identical', total: 0, commits: [] });
  assert.deepEqual(await commitsBetween({ get, repo: 'o/r', base: 'old', head: 'new' }), { status: undefined, total: 1, commits: [{ sha: 'c3', subject: 'docs: three' }] });
  await assert.rejects(commitsBetween({ get, repo: 'o/r', base: 'x', head: 'y' }), /GET repos\/o\/r\/compare\/x\.\.\.y failed with HTTP 404/);
});
