import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./desktop-nightly-guard.mjs', import.meta.url));
const repo = 'MoonshotAI/kimi-code';
const dirs = [];

function versionPr(number = 4983) {
  const branch = 'release/2026-11-13-2';
  return {
    number,
    base: { ref: branch, sha: `base-${number}`, repo: { full_name: repo } },
    head: { ref: `changeset-release/${branch}`, sha: `head-${number}`, repo: { full_name: repo } },
  };
}

function packageJson(version) {
  return `${JSON.stringify({ name: 'kimi-code-app', version, private: true }, null, 2)}\n`;
}

function releasePlan(branch, packages) {
  return `${JSON.stringify({ branch, changesets: [], packages }, null, 2)}\n`;
}

function desktopFixtures(pr, packages = [{ name: 'kimi-code-app', path: 'apps/desktop', version: '1.4.1', private: true }]) {
  return {
    [`${pr.base.sha}:apps/desktop/package.json`]: packageJson('1.4.0'),
    [`${pr.head.sha}:apps/desktop/package.json`]: packageJson('1.4.1'),
    [`${pr.head.sha}:.changeset/release-plan.json`]: releasePlan(pr.base.ref, packages),
  };
}

function run(overrides = {}, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-nightly-guard-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  const state = { prs: [], files: {}, contents: {}, calls: [], ...overrides };
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
const args = process.argv.slice(2);
state.calls.push(args);
fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
if (args[0] !== 'api') process.exit(2);
const route = args[1];
if (route.endsWith('/pulls?state=open&per_page=100')) {
  console.log(JSON.stringify([state.prs]));
} else if (route.includes('/files?per_page=100')) {
  const number = Number(route.match(/\\/pulls\\/(\\d+)\\/files/)[1]);
  console.log(JSON.stringify([state.files[number] || []]));
} else if (route.includes('/contents/')) {
  const [path, query] = route.split('/contents/')[1].split('?');
  const ref = new URLSearchParams(query).get('ref');
  const key = ref + ':' + path;
  if (!(key in state.contents)) {
    console.error('missing content fixture: ' + key);
    process.exit(1);
  }
  process.stdout.write(state.contents[key]);
} else {
  console.error('unexpected route: ' + route);
  process.exit(2);
}
`, { mode: 0o755 });
  const output = join(dir, 'output');
  const summary = join(dir, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: {
    ...process.env,
    PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
    TEST_STATE: stateFile,
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_REPOSITORY: repo,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    ...env,
  } });
  return {
    ...result,
    output: readFileSync(output, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
    calls: JSON.parse(readFileSync(stateFile, 'utf8')).calls,
  };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

await test('Desktop-only version PR skips nightly with package and release plan evidence', () => {
  const pr = versionPr();
  const result = run({
    prs: [pr],
    files: { [pr.number]: [
      { filename: 'apps/desktop/package.json' },
      { filename: 'apps/desktop/CHANGELOG.md' },
      { filename: '.changeset/release-plan.json' },
    ] },
    contents: desktopFixtures(pr),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'skip=true\n');
  assert.match(result.stdout, /"desktopVersionChange":true/);
  assert.match(result.stdout, /package:1\.4\.0->1\.4\.1/);
  assert.match(result.summary, /#4983: \*\*Desktop version change; skip nightly\*\*/);
});

await test('CLI-only #4983 does not block nightly', () => {
  const pr = versionPr(4983);
  const result = run({
    prs: [pr],
    files: { [pr.number]: [
      { filename: '.changeset/calm-pandas-resume.md' },
      { filename: 'apps/kimi-code/CHANGELOG.md' },
      { filename: 'apps/kimi-code/package.json' },
      { filename: 'packages/node-sdk/CHANGELOG.md' },
      { filename: 'packages/node-sdk/package.json' },
    ] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'skip=false\n');
  assert.match(result.stdout, /"number":4983,"base":"release\/2026-11-13-2","desktopVersionChange":false/);
  assert.equal(result.calls.filter((args) => args[1]?.includes('/contents/')).length, 0);
});

await test('mixed CLI and Desktop version PR skips nightly', () => {
  const pr = versionPr(5000);
  const result = run({
    prs: [pr],
    files: { [pr.number]: [
      { filename: 'apps/kimi-code/package.json' },
      { filename: 'apps/desktop/package.json' },
      { filename: 'apps/desktop/CHANGELOG.md' },
      { filename: '.changeset/release-plan.json' },
    ] },
    contents: desktopFixtures(pr, [
      { name: '@moonshot-ai/kimi-code', path: 'apps/kimi-code', version: '2.6.3', private: false },
      { name: 'kimi-code-app', path: 'apps/desktop', version: '1.4.1', private: true },
    ]),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'skip=true\n');
  assert.match(result.stdout, /"desktopVersionChange":true/);
});

await test('unreadable Desktop version evidence fails closed with diagnostics', () => {
  const pr = versionPr(5001);
  const result = run({
    prs: [pr],
    files: { [pr.number]: [{ filename: 'apps/desktop/package.json' }] },
    contents: {
      [`${pr.base.sha}:apps/desktop/package.json`]: packageJson('1.4.0'),
      [`${pr.head.sha}:apps/desktop/package.json`]: '{not json',
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.output, 'skip=true\n');
  assert.match(result.stderr, /failed closed: PR #5001 Desktop package/);
  assert.match(result.stderr, /invalid JSON/);
});

await test('contradictory Desktop package and release plan fail closed', () => {
  const pr = versionPr(5004);
  const result = run({
    prs: [pr],
    files: { [pr.number]: [
      { filename: 'apps/desktop/package.json' },
      { filename: '.changeset/release-plan.json' },
    ] },
    contents: desktopFixtures(pr, [
      { name: 'kimi-code-app', path: 'apps/desktop', version: '1.4.2', private: true },
    ]),
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.output, 'skip=true\n');
  assert.match(result.stderr, /PR #5004: Desktop package and release plan disagree/);
});

await test('release plan alone detects a Desktop dependency-propagation bump', () => {
  const pr = versionPr(5002);
  const result = run({
    prs: [pr],
    files: { [pr.number]: [{ filename: '.changeset/release-plan.json' }] },
    contents: {
      [`${pr.head.sha}:.changeset/release-plan.json`]: releasePlan(pr.base.ref, [
        { name: 'kimi-code-app', path: 'apps/desktop', version: '1.4.1', private: true },
      ]),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'skip=true\n');
  assert.match(result.stdout, /release-plan:1\.4\.1/);
});

await test('non-release and cross-repository PRs are not candidates', () => {
  const pr = versionPr(5003);
  const result = run({ prs: [
    { ...pr, number: 1, base: { ...pr.base, ref: 'main' }, head: { ...pr.head, ref: 'changeset-release/main' } },
    { ...pr, number: 2, head: { ...pr.head, repo: { full_name: 'fork/kimi-code' } } },
    { ...pr, number: 3, head: { ...pr.head, ref: 'feature/desktop' } },
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'skip=false\n');
  assert.equal(result.calls.length, 1);
});

await test('non-schedule runs preserve existing behavior without API calls', () => {
  const result = run({}, { GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'skip=false\n');
  assert.equal(result.calls.length, 0);
});
