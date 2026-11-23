import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workflow = readFileSync(resolve('.github/workflows/desktop-build.yml'), 'utf8');
const marker = '        run: |\n          set -euo pipefail\n          version="$CANARY_VERSION"';
const start = workflow.indexOf(marker);
assert.notEqual(start, -1);
const script = workflow.slice(start + '        run: |\n'.length).split('\n').map((line) => {
  if (line === '') return '';
  assert.ok(line.startsWith('          '));
  return line.slice(10);
}).join('\n');
const sha = 'f90ccb1ab0a2ccc7fa9404590e0d8c249876be81';
const version = '1.4.0-canary.20261119064226-f90ccb1';
const tag = `kimi-code-desktop@${version}`;
const title = `Kimi Code Desktop ${version}`;

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'desktop-canary-publish-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'bin'));
  mkdirSync(join(cwd, 'dist-desktop-canary'));
  writeFileSync(join(cwd, 'dist-desktop-canary/a.txt'), 'a');
  writeFileSync(join(cwd, 'dist-desktop-canary/b.txt'), 'b');
  writeFileSync(join(cwd, 'publish.sh'), script);
  const stateFile = join(cwd, 'state.json');
  const initial = { release: null, uploads: [], createCalls: 0, uploadCalls: 0, failUpload: true, viewError: '' };
  writeFileSync(stateFile, JSON.stringify(initial));
  const stub = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const file = process.env.STATE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (args[0] === 'release' && args[1] === 'view') {
  if (state.viewError) { console.error(state.viewError); process.exit(1); }
  if (!state.release) { console.error('release not found'); process.exit(1); }
  console.log(JSON.stringify({ ...state.release, assets: state.uploads.map(name => ({ name })) }));
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create') {
  state.createCalls += 1;
  state.release = {
    tagName: args[2],
    targetCommitish: args[args.indexOf('--target') + 1],
    name: args[args.indexOf('--title') + 1],
    isDraft: false,
    isPrerelease: args.includes('--prerelease'),
  };
  state.uploads = [];
  save();
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'upload') {
  if (!state.release) process.exit(4);
  const files = args.slice(3).map(file => file.split('/').pop());
  if (files.some(name => state.uploads.includes(name))) process.exit(8);
  state.uploadCalls += 1;
  if (state.failUpload) {
    state.uploads.push(files[0]);
    state.failUpload = false;
    save();
    process.exit(1);
  }
  state.uploads.push(...files);
  save();
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(join(cwd, 'bin/gh'), stub, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(cwd, 'bin')}:${process.env.PATH}`, STATE_FILE: stateFile, CANARY_VERSION: version, GITHUB_SHA: sha, GITHUB_REF_NAME: 'main' };
  return { cwd, env, stateFile };
}

function run(f) {
  return spawnSync('bash', [join(f.cwd, 'publish.sh')], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
}

function state(f) {
  return JSON.parse(readFileSync(f.stateFile, 'utf8'));
}

void test('Desktop Canary publish resumes after create succeeded and upload failed', (t) => {
  const f = fixture(t);
  const first = run(f);
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.equal(state(f).createCalls, 1);
  assert.deepEqual(state(f).uploads, ['a.txt']);
  const second = run(f);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(state(f).createCalls, 1);
  assert.equal(state(f).uploadCalls, 2);
  assert.deepEqual(state(f).uploads, ['a.txt', 'b.txt']);
  assert.equal(state(f).release.tagName, tag);
  assert.equal(state(f).release.targetCommitish, sha);
  assert.equal(state(f).release.name, title);
  assert.equal(state(f).release.isDraft, false);
  assert.equal(state(f).release.isPrerelease, true);
  const third = run(f);
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.equal(state(f).createCalls, 1);
  assert.equal(state(f).uploadCalls, 2);
});

void test('Desktop Canary publish rejects mismatched existing releases without mutation', async (t) => {
  const cases = [
    ['tagName', 'kimi-code-desktop@other'],
    ['targetCommitish', '0'.repeat(40)],
    ['name', 'Kimi Code Canary'],
    ['isDraft', true],
    ['isPrerelease', false],
  ];
  for (const [key, value] of cases) {
    await t.test(key, (t) => {
      const f = fixture(t);
      const current = state(f);
      current.release = { tagName: tag, targetCommitish: sha, name: title, isDraft: false, isPrerelease: true };
      current.release[key] = value;
      current.uploads = ['a.txt', 'b.txt'];
      current.failUpload = false;
      writeFileSync(f.stateFile, JSON.stringify(current));
      const result = run(f);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(state(f).createCalls, 0);
      assert.equal(state(f).uploadCalls, 0);
      assert.equal(state(f).release[key], value);
    });
  }
});

void test('Desktop Canary publish does not create after a non-404 lookup failure', (t) => {
  const f = fixture(t);
  const current = state(f);
  current.viewError = 'gateway unavailable';
  writeFileSync(f.stateFile, JSON.stringify(current));
  const result = run(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(state(f).createCalls, 0);
  assert.equal(state(f).uploadCalls, 0);
});
