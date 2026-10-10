import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const desktop = false;
const releaseScript = fileURLToPath(new URL('./release.mjs', import.meta.url));
const versionScript = fileURLToPath(new URL('./version-release.mjs', import.meta.url));
const dirs = [];
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const branch = 'release/test';
const name = desktop ? 'kimi-code-app' : '@moonshot-ai/kimi-code';
const path = desktop ? 'apps/desktop' : 'apps/kimi-code';
const tag = desktop ? 'v1.0.1' : `${name}@1.0.1`;

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-test-'));
  dirs.push(dir);
  mkdirSync(join(dir, path), { recursive: true });
  mkdirSync(join(dir, '.changeset'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'release-fixture', private: true }));
  const pkg = { name, version: '1.0.1', private: desktop };
  writeFileSync(join(dir, path, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, path, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1\n\nFix a bug.\n\n## 1.0.0\n\nOld notes.\n');
  writeFileSync(join(dir, '.changeset/README.md'), '# Changesets');
  writeFileSync(join(dir, '.changeset/release-plan.json'), JSON.stringify({ branch, packages: [{ ...pkg, path }] }));
  const state = {
    runs: [{ id: 1, head_sha: sha, head_branch: branch, event: 'push', status: 'completed', conclusion: 'success' }],
    tags: {}, releases: {}, calls: [], ...overrides,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.RELEASE_TEST_STATE;
const state = JSON.parse(fs.readFileSync(file));
const args = process.argv.slice(2);
state.calls.push(args);
function done(value) { fs.writeFileSync(file, JSON.stringify(state)); console.log(JSON.stringify(value)); }
function missing() { fs.writeFileSync(file, JSON.stringify(state)); console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
if (state.apiError) { console.error('gh: Forbidden (HTTP 403)'); process.exit(1); }
const endpoint = args[1] || '';
if (args[0] === 'api') {
  if (endpoint === 'graphql') {
    const tag = args.find(x => x.startsWith('tag=')).slice(4);
    done({ data: { repository: { release: state.releases[tag] ? { isDraft: state.releases[tag].draft } : null } } });
  } else if (endpoint.includes('/actions/workflows/')) done({ workflow_runs: state.runs });
  else if (endpoint.includes('/git/ref/tags/')) {
    const tag = decodeURIComponent(endpoint.split('/git/ref/tags/')[1]);
    if (!state.tags[tag]) missing();
    done({ object: { type: 'commit', sha: state.tags[tag] } });
  } else if (endpoint.endsWith('/git/refs')) {
    const tag = args.find(x => x.startsWith('ref=')).slice('ref=refs/tags/'.length);
    state.tags[tag] = args.find(x => x.startsWith('sha=')).slice(4);
    done({});
  } else if (endpoint.includes('/releases/tags/')) {
    const tag = decodeURIComponent(endpoint.split('/releases/tags/')[1]);
    if (!state.releases[tag]) missing();
    done(state.releases[tag]);
  } else throw new Error('Unexpected API: ' + endpoint);
} else if (args[0] === 'release' && args[1] === 'create') {
  state.releases[args[2]] = { draft: true, notes: fs.readFileSync(0, 'utf8') };
  done({});
} else if (args[0] === 'release' && args[1] === 'edit') {
  state.releases[args[2]].draft = false;
  done({});
} else throw new Error('Unexpected command: ' + args);
`, { mode: 0o755 });
  writeFileSync(join(dir, 'bin/pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = ${JSON.stringify(path)};
const file = path + '/package.json';
const pkg = JSON.parse(fs.readFileSync(file));
if (process.argv.includes('list')) console.log(JSON.stringify([{ path: process.cwd() }, { path: process.cwd() + '/' + path }]));
else if (process.argv.slice(2).join(' ') === 'changeset version') {
  pkg.version = '1.0.2';
  fs.writeFileSync(file, JSON.stringify(pkg));
  fs.unlinkSync('.changeset/fix.md');
} else throw new Error('Unexpected pnpm command');
`, { mode: 0o755 });
  return {
    dir,
    env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, RELEASE_TEST_STATE: join(dir, 'state.json'),
      GITHUB_REPOSITORY: 'example/project', GITHUB_REF: `refs/heads/${branch}`, GITHUB_REF_NAME: branch,
      GITHUB_SHA: sha, EXPECTED_SHA: sha, GITHUB_OUTPUT: join(dir, 'output') },
    state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
  };
}

function run(f, command, env = {}) {
  return spawnSync(process.execPath, [releaseScript, command], { cwd: f.dir, env: { ...f.env, ...env }, encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

void test('accepts only the tested release commit', () => {
  const f = fixture();
  assert.equal(run(f, 'check').status, 0);
  assert.match(run(f, 'check', { EXPECTED_SHA: otherSha }).stderr, /expected_sha/);
  assert.match(run(f, 'check', { GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main' }).stderr, /release\/\*/);
  assert.match(run(f, 'check', { GITHUB_REF: `refs/tags/${branch}` }).stderr, /release\/\*/);
});

void test('rejects an old plan and unconsumed changesets', () => {
  const f = fixture();
  writeFileSync(join(f.dir, '.changeset/fix.md'), '---\n---\n');
  assert.match(run(f, 'check').stderr, /Unconsumed changesets/);
  rmSync(join(f.dir, '.changeset/fix.md'));
  writeFileSync(join(f.dir, path, 'package.json'), JSON.stringify({ name, version: '1.0.2', private: desktop }));
  assert.match(run(f, 'check').stderr, /no longer matches/);
  const next = fixture();
  assert.match(run(next, 'check', { GITHUB_REF: 'refs/heads/release/next', GITHUB_REF_NAME: 'release/next' }).stderr, /version PR/);
});

void test('does not accept PR checks, another SHA, or a superseded green run', () => {
  for (const override of [{ event: 'pull_request' }, { head_sha: otherSha }, { conclusion: 'failure' }, { status: 'in_progress' }]) {
    const f = fixture();
    const state = f.state();
    state.runs.push({ ...state.runs[0], id: 2, ...override });
    if (override.event || override.head_sha) state.runs.shift();
    writeFileSync(join(f.dir, 'state.json'), JSON.stringify(state));
    assert.match(run(f, 'check').stderr, /CI run/);
  }
});

void test('API failure and existing tags on another commit stop publication', () => {
  assert.match(run(fixture({ apiError: true }), 'check').stderr, /Forbidden/);
  assert.match(run(fixture({ tags: { [tag]: otherSha } }), 'prepare').stderr, /another commit/);
});

void test('prepares a draft and retries an interrupted release from the same SHA', () => {
  const f = fixture();
  assert.equal(run(f, 'prepare').status, 0);
  assert.equal(f.state().tags[tag], sha);
  assert.equal(f.state().releases[tag].draft, true);
  assert.match(f.state().releases[tag].notes, /Fix a bug/);
  assert.doesNotMatch(f.state().releases[tag].notes, /Old notes/);
  assert.match(readFileSync(join(f.dir, 'output'), 'utf8'), /build=true/);
  assert.equal(run(f, 'prepare').status, 0);
  assert.equal(f.state().calls.filter(x => x[0] === 'release' && x[1] === 'create').length, 1);
  assert.equal(run(f, 'finish').status, 0);
  assert.equal(f.state().releases[tag].draft, false);
  writeFileSync(join(f.dir, 'output'), '');
  assert.equal(run(f, 'prepare').status, 0);
  assert.match(readFileSync(join(f.dir, 'output'), 'utf8'), /build=false/);
});

void test('version command records the consumed changesets and changed package versions', () => {
  const f = fixture();
  writeFileSync(join(f.dir, '.changeset/fix.md'), '---\n---\n');
  const result = spawnSync(process.execPath, [versionScript], { cwd: f.dir, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(join(f.dir, '.changeset/release-plan.json'), 'utf8'));
  assert.equal(plan.branch, branch);
  assert.deepEqual(plan.changesets, ['fix.md']);
  assert.deepEqual(plan.packages, [{ name, path, version: '1.0.2', private: desktop }]);
});

void test('a later version PR retains earlier packages from the same release cycle', () => {
  const f = fixture();
  const earlier = { name: '@example/sdk', path: 'packages/sdk', version: '2.0.0', private: false };
  const planFile = join(f.dir, '.changeset/release-plan.json');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  plan.packages.push(earlier);
  plan.changesets = ['earlier.md'];
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(join(f.dir, '.changeset/fix.md'), '---\n---\n');
  const result = spawnSync(process.execPath, [versionScript], { cwd: f.dir, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const next = JSON.parse(readFileSync(planFile, 'utf8'));
  assert.deepEqual(next.packages, [{ name, path, version: '1.0.2', private: desktop }, earlier]);
  assert.deepEqual(next.changesets, ['fix.md', 'earlier.md']);
});

void test('the next release cycle discards the old package plan', () => {
  const f = fixture();
  const planFile = join(f.dir, '.changeset/release-plan.json');
  writeFileSync(planFile, JSON.stringify({ branch: 'release/old', changesets: ['old.md'], packages: [{ name: '@example/old' }] }));
  writeFileSync(join(f.dir, '.changeset/fix.md'), '---\n---\n');
  const result = spawnSync(process.execPath, [versionScript], { cwd: f.dir, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const next = JSON.parse(readFileSync(planFile, 'utf8'));
  assert.equal(next.packages.length, 1);
  assert.deepEqual(next.changesets, ['fix.md']);
});
