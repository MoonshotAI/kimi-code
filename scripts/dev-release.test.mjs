import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDevRecord,
  compareDevVersions,
  computeDevVersion,
  findNewerDevVersion,
  isCompleteDevRelease,
  parseDevVersion,
  readDevRelease,
  requiredDevReleaseAssets,
  selectDevCommit,
} from './dev-release.mjs';

await test('dev versions use the workflow run number', () => {
  assert.equal(computeDevVersion(42), '0.0.0-dev.42');
  assert.throws(() => computeDevVersion(0), /positive integer/);
});

await test('dev version parsing accepts only the fixed base and numeric run number', () => {
  assert.deepEqual(parseDevVersion('0.0.0-dev.42'), { runNumber: 42 });
  for (const bad of ['2.4.0', '0.0.0-dev-42', '0.0.0-dev.042', '1.0.0-dev.42', '0.0.0-dev.42.1']) {
    assert.equal(parseDevVersion(bad), null, bad);
  }
});

await test('dev version ordering compares run numbers numerically', () => {
  assert.ok(compareDevVersions('0.0.0-dev.100000', '0.0.0-dev.99999') > 0);
  assert.equal(compareDevVersions('0.0.0-dev.42', '0.0.0-dev.42'), 0);
  assert.throws(() => compareDevVersions('0.0.0-dev-42', '0.0.0-dev.42'), /not dev versions/);
});

await test('dev record contains only the client channel pointer fields', () => {
  const input = { version: '0.0.0-dev.42', publishedAt: '2026-10-26T01:00:00.000Z' };
  assert.deepEqual(buildDevRecord(input), {
    schemaVersion: 1,
    version: '0.0.0-dev.42',
    publishedAt: '2026-10-26T01:00:00.000Z',
    rollout: [],
  });
  assert.throws(() => buildDevRecord({ ...input, version: '2.4.0' }), /invalid dev version/);
  assert.throws(() => buildDevRecord({ ...input, publishedAt: 'not-a-date' }), /publishedAt/);
});

await test('a complete dev release contains the pointer and every native artifact', () => {
  const names = requiredDevReleaseAssets();
  assert.equal(names.length, 38);
  const release = { isDraft: false, assets: names.map((name) => ({ name })) };
  assert.equal(isCompleteDevRelease(release), true);
  assert.equal(isCompleteDevRelease({ ...release, isDraft: true }), false);
  assert.equal(isCompleteDevRelease({
    ...release,
    assets: release.assets.filter((asset) => asset.name !== 'dev.json'),
  }), false);
  assert.equal(isCompleteDevRelease({
    ...release,
    assets: release.assets.filter((asset) => asset.name !== 'kimi-code-linux-x64.zst'),
  }), false);
});

await test('release lookup tolerates only a missing release and propagates other failures', () => {
  const release = { isDraft: false, assets: [] };
  assert.deepEqual(readDevRelease('tag', () => release), release);
  assert.equal(readDevRelease('missing', () => { throw new Error('HTTP 404: Not Found'); }), null);
  assert.equal(readDevRelease('missing', () => { throw new Error('release not found'); }), null);
  assert.throws(
    () => readDevRelease('tag', () => { throw new Error('rate limited'); }),
    /rate limited/,
  );
  assert.throws(
    () => readDevRelease('tag', () => { throw new SyntaxError('Unexpected token'); }),
    /Unexpected token/,
  );
});

await test('dev release accepts only the latest main commit with successful CI', () => {
  const input = { ref: 'refs/heads/main', sha: 'c', greenShas: ['a', 'b'], devReleases: [] };
  assert.throws(() => selectDevCommit(input), /latest main commit c has not passed CI/);
  assert.deepEqual(selectDevCommit({ ...input, greenShas: ['a', 'b', 'c'] }), {
    sha: 'c',
    skip: false,
    reason: '',
  });
  assert.throws(() => selectDevCommit({ ...input, ref: 'refs/heads/release/2.4', greenShas: ['c'] }), /only from main/);
});

await test('a new task skips a complete release but resumes a partial release', () => {
  const input = {
    ref: 'refs/heads/main',
    sha: 'c',
    greenShas: ['c'],
    devReleases: [{ tag: '@moonshot-ai/kimi-code@0.0.0-dev.42', isComplete: true }],
  };
  assert.deepEqual(selectDevCommit(input), {
    sha: 'c',
    skip: true,
    reason: 'c already has @moonshot-ai/kimi-code@0.0.0-dev.42',
  });
  assert.deepEqual(selectDevCommit({
    ...input,
    devReleases: [{ tag: '@moonshot-ai/kimi-code@0.0.0-dev.42', isComplete: false }],
  }), {
    sha: 'c',
    skip: false,
    reason: '',
  });
});

await test('an older dev run is stale after a newer run publishes', () => {
  assert.equal(findNewerDevVersion('0.0.0-dev.42', ['0.0.0-dev.41', '0.0.0-dev.43']), '0.0.0-dev.43');
  assert.equal(findNewerDevVersion('0.0.0-dev.42', ['0.0.0-dev.41', '0.0.0-dev.42']), null);
});
