import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildCanaryRecord,
  compareCanaryVersions,
  computeCanaryBaseVersion,
  computeCanaryVersion,
  findNewerCanaryVersion,
  isCompleteCanaryRelease,
  listSuccessfulMainCiShas,
  PACKAGE_NAME,
  parseCanaryVersion,
  readCanaryRelease,
  readNpmCanaryVersion,
  requiredCanaryReleaseAssets,
  resolveCanaryBaseVersion,
  selectCanaryCommit,
} from './canary-release.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CANARY = '2.3.3-canary.20261028012345-0123456';

await test('canary versions combine the package base, UTC publish time, and short commit', () => {
  const input = { baseVersion: '2.3.3', publishedAt: '2026-10-28T01:23:45Z', sha: SHA };
  assert.equal(computeCanaryVersion(input), CANARY);
  assert.equal(computeCanaryVersion({ ...input, publishedAt: '2026-10-28T09:23:45+08:00' }), CANARY);
  assert.throws(() => computeCanaryVersion({ ...input, baseVersion: '2.4.0-beta.0' }), /plain x\.y\.z/);
  assert.throws(() => computeCanaryVersion({ ...input, publishedAt: 'not-a-date' }), /publishedAt/);
  assert.throws(() => computeCanaryVersion({ ...input, sha: '0123456' }), /full commit sha/);
});

await test('canary base uses the CLI newVersion from the release plan', () => {
  for (const [type, newVersion] of [['patch', '2.4.1'], ['minor', '2.5.0'], ['major', '3.0.0']]) {
    const releasePlan = { releases: [{ name: PACKAGE_NAME, type, newVersion, changesets: ['cli-change'] }] };
    assert.equal(computeCanaryBaseVersion({ releasePlan, packageVersion: '2.4.0' }), newVersion);
  }
  const dependencyPlan = { releases: [{ name: PACKAGE_NAME, type: 'patch', newVersion: '2.4.1', changesets: [] }] };
  assert.equal(computeCanaryBaseVersion({ releasePlan: dependencyPlan, packageVersion: '2.4.0' }), '2.4.1');
});

await test('canary base increments patch only when the release plan has no CLI release', () => {
  for (const releases of [
    [],
    [{ name: '@example/other', type: 'major', newVersion: '2.0.0', changesets: ['other-change'] }],
  ]) {
    assert.equal(computeCanaryBaseVersion({ releasePlan: { releases }, packageVersion: '2.4.0' }), '2.4.1');
  }
});

await test('canary base rejects malformed release plans and non-plain versions', () => {
  for (const releasePlan of [
    {},
    { releases: [{}] },
    { releases: [{ name: PACKAGE_NAME, newVersion: '2.5.0-next.0' }] },
  ]) {
    assert.throws(() => computeCanaryBaseVersion({ releasePlan, packageVersion: '2.4.0' }));
  }
});

await test('changeset status provides the canary base from its output file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-base-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputFile = join(dir, 'release-plan.json');
  let invocation;
  const baseVersion = resolveCanaryBaseVersion({
    outputFile,
    packageVersion: '2.4.0',
    execute(command, args, options) {
      invocation = { command, args, options };
      writeFileSync(outputFile, JSON.stringify({
        releases: [{ name: PACKAGE_NAME, newVersion: '2.4.1', changesets: [] }],
      }));
    },
  });
  assert.equal(baseVersion, '2.4.1');
  assert.deepEqual(invocation, {
    command: 'pnpm',
    args: ['changeset', 'status', '--output', outputFile],
    options: { stdio: 'inherit' },
  });
});

await test('changeset status failures do not fall back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-base-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => resolveCanaryBaseVersion({
    outputFile: join(dir, 'failed.json'),
    packageVersion: '2.4.0',
    execute() { throw new Error('status failed'); },
  }), /status failed/);
  assert.throws(() => resolveCanaryBaseVersion({
    outputFile: join(dir, 'missing.json'),
    packageVersion: '2.4.0',
    execute() {},
  }), /ENOENT/);
  const damagedFile = join(dir, 'damaged.json');
  writeFileSync(damagedFile, '{');
  assert.throws(() => resolveCanaryBaseVersion({
    outputFile: damagedFile,
    packageVersion: '2.4.0',
    execute() {},
  }), SyntaxError);
});

await test('canary version parsing accepts only a plain base, a 14-digit time, and a 7-hex commit', () => {
  assert.deepEqual(parseCanaryVersion(CANARY), { base: [2, 3, 3], timestamp: '20261028012345', commit: '0123456' });
  for (const bad of [
    '2.3.3',
    '0.0.0-dev.42',
    '2.3.3-canary.20261028012345.g0123456',
    '2.3.3-canary.2026102801234-0123456',
    '2.3.3-canary.20261028012345-012345',
    '2.3.3-canary.20261028012345-ABCDEF0',
    '2.3.3-canary.20261028012345-0123456.1',
    '02.3.3-canary.20261028012345-0123456',
    '2.4.0-beta.0-canary.20261028012345-0123456',
  ]) {
    assert.equal(parseCanaryVersion(bad), null, bad);
  }
});

await test('canary ordering compares the base numerically, then the publish time, then the commit', () => {
  assert.ok(compareCanaryVersions('2.3.3-canary.20261028000000-0000000', '2.3.3-canary.20261027235959-fffffff') > 0);
  assert.ok(compareCanaryVersions('2.3.4-canary.20200101000000-0000000', '2.3.3-canary.20991231235959-fffffff') > 0);
  assert.ok(compareCanaryVersions('2.10.0-canary.20261028000000-0000000', '2.9.0-canary.20261028000000-0000000') > 0);
  assert.equal(compareCanaryVersions(CANARY, CANARY), 0);
  assert.throws(() => compareCanaryVersions('0.0.0-dev.42', CANARY), /not canary versions/);
});

await test('canary record contains only the client channel pointer fields', () => {
  const input = { version: CANARY, publishedAt: '2026-10-28T01:23:45Z' };
  assert.deepEqual(buildCanaryRecord(input), {
    schemaVersion: 1,
    version: CANARY,
    publishedAt: '2026-10-28T01:23:45Z',
    rollout: [],
  });
  assert.throws(() => buildCanaryRecord({ ...input, version: '2.4.0' }), /invalid canary version/);
  assert.throws(() => buildCanaryRecord({ ...input, publishedAt: 'not-a-date' }), /publishedAt/);
});

await test('a complete canary release contains the pointer and every native artifact', () => {
  const names = requiredCanaryReleaseAssets();
  assert.equal(names.length, 38);
  const release = { isDraft: false, assets: names.map((name) => ({ name })) };
  assert.equal(isCompleteCanaryRelease(release), true);
  assert.equal(isCompleteCanaryRelease({ ...release, isDraft: true }), false);
  assert.equal(isCompleteCanaryRelease({
    ...release,
    assets: release.assets.filter((asset) => asset.name !== 'canary.json'),
  }), false);
  assert.equal(isCompleteCanaryRelease({
    ...release,
    assets: release.assets.filter((asset) => asset.name !== 'kimi-code-linux-x64.zst'),
  }), false);
});

await test('release lookup tolerates only a missing release and propagates other failures', () => {
  const release = { isDraft: false, assets: [] };
  assert.deepEqual(readCanaryRelease('tag', () => release), release);
  assert.equal(readCanaryRelease('missing', () => { throw new Error('HTTP 404: Not Found'); }), null);
  assert.equal(readCanaryRelease('missing', () => { throw new Error('release not found'); }), null);
  assert.throws(
    () => readCanaryRelease('tag', () => { throw new Error('rate limited'); }),
    /rate limited/,
  );
  assert.throws(
    () => readCanaryRelease('tag', () => { throw new SyntaxError('Unexpected token'); }),
    /Unexpected token/,
  );
});

await test('canary release accepts only the latest main commit with successful CI', () => {
  const input = { ref: 'refs/heads/main', sha: 'c', greenShas: ['a', 'b'], canaryReleases: [] };
  assert.throws(() => selectCanaryCommit(input), /latest main commit c has not passed CI/);
  assert.deepEqual(selectCanaryCommit({ ...input, greenShas: ['a', 'b', 'c'] }), {
    sha: 'c',
    skip: false,
    reason: '',
  });
  assert.throws(() => selectCanaryCommit({ ...input, ref: 'refs/heads/release/2.4', greenShas: ['c'] }), /only from main/);
});

await test('CI selection asks gh to return only successful main head SHAs', () => {
  let invocation;
  const shas = listSuccessfulMainCiShas('MoonshotAI/kimi-code', (command, args, options) => {
    invocation = { command, args, options };
    return 'a\n\nb\n';
  });
  assert.deepEqual(shas, ['a', 'b']);
  assert.equal(invocation.command, 'gh');
  assert.equal(
    invocation.args[1],
    'repos/MoonshotAI/kimi-code/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100',
  );
  assert.deepEqual(invocation.args.slice(2), ['--jq', '.workflow_runs[].head_sha']);
  assert.deepEqual(invocation.options, { encoding: 'utf8' });
});

await test('a new task skips a complete release but resumes a partial release', () => {
  const input = {
    ref: 'refs/heads/main',
    sha: 'c',
    greenShas: ['c'],
    canaryReleases: [{ tag: `@moonshot-ai/kimi-code@${CANARY}`, isComplete: true }],
  };
  assert.deepEqual(selectCanaryCommit(input), {
    sha: 'c',
    skip: true,
    reason: `c already has @moonshot-ai/kimi-code@${CANARY}`,
  });
  assert.deepEqual(selectCanaryCommit({
    ...input,
    canaryReleases: [{ tag: `@moonshot-ai/kimi-code@${CANARY}`, isComplete: false }],
  }), {
    sha: 'c',
    skip: false,
    reason: '',
  });
});

await test('an older canary run is stale after a newer run publishes', () => {
  const older = '2.3.3-canary.20261027012345-fffffff';
  const newer = '2.3.3-canary.20261029012345-0000000';
  assert.equal(findNewerCanaryVersion(CANARY, [older, newer]), newer);
  assert.equal(findNewerCanaryVersion(CANARY, [older, CANARY]), null);
});

await test('npm canary lookup stays enabled for stale-publish protection', () => {
  let invocation;
  const version = readNpmCanaryVersion((command, args, options) => {
    invocation = { command, args, options };
    return `${CANARY}\n`;
  });
  assert.equal(version, CANARY);
  assert.deepEqual(invocation, {
    command: 'npm',
    args: ['view', PACKAGE_NAME, 'dist-tags.canary'],
    options: { encoding: 'utf8' },
  });
  assert.equal(readNpmCanaryVersion(() => ''), '');
  assert.throws(() => readNpmCanaryVersion(() => '2.4.0'), /npm canary tag is malformed/);
});
