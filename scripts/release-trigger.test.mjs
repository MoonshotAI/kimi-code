import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./release-trigger.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const branch = 'release/test';
const repo = 'example/project';
const dirs = [];
const pr = {
  merged_at: '2026-10-14T00:00:00Z', merge_commit_sha: sha,
  base: { ref: branch, repo: { full_name: repo } },
  head: { ref: `changeset-release/${branch}`, repo: { full_name: repo } },
};
function run(overrides = {}, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-trigger-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  const state = { pulls: [pr], watchStatus: 0, calls: [], ...overrides };
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
const args = process.argv.slice(2);
state.calls.push(args);
fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
if (state.apiError) process.exit(1);
if (args[0] === 'run') process.exit(state.watchStatus);
if (args[1].includes('/pulls?')) console.log(JSON.stringify([state.pulls]));
else if (args[1].includes('/actions/workflows/ci.yml/runs?')) console.log(JSON.stringify({workflow_runs: [
 {id: 7, head_sha: '${sha}', head_branch: '${branch}', event: 'push'},
 {id: 8, head_sha: '${'b'.repeat(40)}', head_branch: '${branch}', event: 'push'},
 {id: 9, head_sha: '${sha}', head_branch: '${branch}', event: 'pull_request'}
]}));
else process.exit(2);
`, { mode: 0o755 });
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
    ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
    TEST_STATE: stateFile, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: repo, GITHUB_REF_NAME: branch, GITHUB_REF: `refs/heads/${branch}`, GITHUB_SHA: sha, ...env,
  } });
  return { ...result, output: readFileSync(output, 'utf8'), calls: JSON.parse(readFileSync(stateFile, 'utf8')).calls };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

await test('merged version PR waits for its push CI, not newer or PR runs', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'publish=true\n');
  assert.deepEqual(result.calls.at(-1), ['run', 'watch', '7', '--repo', repo, '--exit-status', '--interval', '10']);
});

await test('ordinary pushes, unmerged PRs, other branches and forks do not publish', () => {
  for (const pulls of [[], [{ ...pr, merged_at: null }], [{ ...pr, merge_commit_sha: 'b'.repeat(40) }],
    [{ ...pr, base: { ...pr.base, ref: 'release/other' } }],
    [{ ...pr, head: { ...pr.head, ref: 'fix/bug' } }],
    [{ ...pr, head: { ...pr.head, repo: { full_name: 'fork/project' } } }],
    [{ ...pr, head: { ...pr.head, repo: null } }]]) {
    const result = run({ pulls });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'publish=false\n');
    assert.equal(result.calls.length, 1);
  }
});

await test('failed or cancelled CI and API failures never authorize publishing', () => {
  for (const state of [{ watchStatus: 1 }, { watchStatus: 2 }, { apiError: true }]) {
    const result = run(state);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
  }
});

await test('manual runs, main and invalid SHA cannot authorize publishing', () => {
  for (const env of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: 'abc' }]) {
    const result = run({}, env);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 0);
    assert.equal(result.output, '');
  }
});
