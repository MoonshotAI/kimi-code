import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(resolve('apps/desktop/package.json'));
const { gt } = require('semver');
const script = resolve('scripts/canary-version.mjs');
const changesetCli = resolve('node_modules/.bin/changeset');

void test('Canary version follows real changesets before and after the release plan is consumed', () => {
  const root = mkdtempSync(join(tmpdir(), 'canary-test-'));
  const cwd = join(root, 'release');
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    mkdirSync(join(cwd, 'apps/desktop'), { recursive: true });
    mkdirSync(join(cwd, '.changeset'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'canary-test', private: true }));
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    writeFileSync(join(cwd, 'apps/desktop/package.json'), JSON.stringify({ name: 'kimi-code-app', version: '1.0.4', private: true }));
    const config = JSON.parse(readFileSync(resolve('.changeset/config.json'), 'utf8'));
    config.ignore = [];
    config.changelog = false;
    writeFileSync(join(cwd, '.changeset/config.json'), JSON.stringify(config));
    writeFileSync(join(root, 'bin/pnpm'), '#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync(process.env.CHANGESET_CLI, process.argv.slice(3), { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n', { mode: 0o755 });
    writeFileSync(join(root, 'bin/gh'), '#!/usr/bin/env node\nif (process.argv[2] === "api") { console.log(JSON.stringify({ created_at: process.env.CANARY_TEST_CREATED_AT })); } else { process.exit(1); }\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CHANGESET_CLI: changesetCli, GITHUB_REF_NAME: 'release/week', GITHUB_REPOSITORY: 'MoonshotAI/kimi-code', GITHUB_RUN_ID: '44474123970', GITHUB_RUN_NUMBER: '108', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'a'.repeat(40), CANARY_TARGET_VERSION: '', CANARY_TEST_CREATED_AT: '2026-11-19T06:42:26Z' };
    const run = (dir = cwd, extra = {}) => spawnSync(process.execPath, [script], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
    const expectVersion = (result, version) => {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `version=${version}-canary.20261119064226-aaaaaaa\n`);
    };

    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.email', 'canary-test@example.invalid');
    git(cwd, 'config', 'user.name', 'Canary test');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'baseline');
    git(cwd, 'switch', '-c', 'release/week');
    writeFileSync(join(cwd, '.changeset/fix.md'), '---\n"kimi-code-app": patch\n---\n\nFix.\n');
    writeFileSync(join(cwd, 'apps/desktop/source.txt'), 'first change');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'pending changeset');
    expectVersion(run(), '1.0.5');
    assert.notEqual(run(cwd, { CANARY_TARGET_VERSION: '1.0.7' }).status, 0);

    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '--depth', '1', '--branch', 'release/week', `file://${cwd}`, shallow], { stdio: 'pipe' });
    assert.match(run(shallow).stderr, /Failed to find where HEAD diverged from "main"/);
    git(shallow, 'fetch', '--unshallow', '--no-tags', 'origin');
    git(shallow, 'fetch', '--no-tags', 'origin', 'main:refs/heads/main');
    expectVersion(run(shallow), '1.0.5');

    unlinkSync(join(cwd, '.changeset/fix.md'));
    writeFileSync(join(cwd, 'apps/desktop/package.json'), JSON.stringify({ name: 'kimi-code-app', version: '1.0.5', private: true }));
    const plan = JSON.stringify({ branch: 'release/week', packages: [{ name: 'kimi-code-app', version: '1.0.5' }] });
    writeFileSync(join(cwd, '.changeset/release-plan.json'), plan);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'consume changeset');
    expectVersion(run(), '1.0.5');
    assert.notEqual(run(cwd, { GITHUB_REF_NAME: 'release/other' }).status, 0);
    writeFileSync(join(cwd, 'apps/desktop/source.txt'), 'hotfix without changeset');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'hotfix');
    expectVersion(run(), '1.0.5');

    writeFileSync(join(cwd, '.changeset/second.md'), '---\n"kimi-code-app": patch\n---\n\nAnother fix.\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'new pending changeset');
    expectVersion(run(), '1.0.6');
    expectVersion(run(cwd, { GITHUB_REF_NAME: 'main' }), '1.0.6');
    expectVersion(run(cwd, { GITHUB_REF_NAME: 'main', CANARY_TARGET_VERSION: '1.0.7' }), '1.0.7');
    assert.equal(run(cwd, { GITHUB_REF_NAME: 'main', CANARY_TARGET_VERSION: '1.0.7', GITHUB_RUN_NUMBER: '15' }).stdout, 'version=1.0.7-canary.20261119064226-aaaaaaa\n');
    assert.equal(run(cwd, { GITHUB_REF_NAME: 'main', CANARY_TARGET_VERSION: '1.0.7', GITHUB_RUN_NUMBER: '15', GITHUB_RUN_ATTEMPT: '99' }).stdout, 'version=1.0.7-canary.20261119064226-aaaaaaa\n');
    assert.notEqual(run(cwd, { GITHUB_REF_NAME: 'main', CANARY_TARGET_VERSION: '1.0.7', CANARY_TEST_CREATED_AT: 'not-a-date' }).status, 0);
    assert.ok(gt('1.0.7-canary.20261119064226-aaaaaaa', '1.0.7-canary.329.1.gaaaaaaaa'));
    writeFileSync(join(cwd, '.changeset/second.md'), '---\n"kimi-code-app": minor\n---\n\nA feature.\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'minor changeset');
    expectVersion(run(cwd, { GITHUB_REF_NAME: 'main' }), '1.1.0');
    unlinkSync(join(cwd, '.changeset/second.md'));
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'consume all changesets');
    expectVersion(run(cwd, { GITHUB_REF_NAME: 'main' }), '1.0.6');
    assert.notEqual(run(cwd, { GITHUB_REF_NAME: 'feat/nightly' }).status, 0);
    execFileSync(process.execPath, [script, '--stamp'], { cwd, env: { ...env, CANARY_VERSION: '1.0.6-canary.20261119064226-aaaaaaa' } });
    assert.equal(JSON.parse(readFileSync(join(cwd, 'apps/desktop/package.json'), 'utf8')).version, '1.0.6-canary.20261119064226-aaaaaaa');
    execFileSync(process.execPath, [script, '--stamp'], { cwd, env: { ...env, CANARY_VERSION: '1.0.6-canary.329.1.gaaaaaaaa' } });
    assert.equal(JSON.parse(readFileSync(join(cwd, 'apps/desktop/package.json'), 'utf8')).version, '1.0.6-canary.329.1.gaaaaaaaa');
    assert.notEqual(spawnSync(process.execPath, [script, '--stamp'], { cwd, env: { ...env, CANARY_VERSION: '1.0.6-canary.20261119064226.1.gaaaaaaa' } }).status, 0);
    assert.equal(readFileSync(join(cwd, '.changeset/release-plan.json'), 'utf8'), plan);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
