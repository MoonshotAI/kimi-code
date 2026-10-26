import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCanaryRecord,
  canaryChanges,
  compareCanaryVersions,
  computeCanaryVersion,
  latestCanaryFromTags,
  parseCanaryVersion,
  parseChangeset,
  pickNewestGreenCommit,
} from './canary-release.mjs';

const at = (iso) => new Date(iso);

await test('canary versions stay above stable and above the previous canary across a release cycle', () => {
  const timeline = [
    { plannedNext: '2.4.0', packageVersion: '2.3.2', stableLatest: '2.3.2', builtAt: '2026-10-26T00:43:00Z', expected: '2.4.0-canary.202610260043' },
    { plannedNext: '2.4.0', packageVersion: '2.3.2', stableLatest: '2.3.2', builtAt: '2026-10-28T00:43:00Z', expected: '2.4.0-canary.202610280043' },
    { plannedNext: '2.4.0', packageVersion: '2.3.2', stableLatest: '2.4.0', builtAt: '2026-10-29T09:10:00Z', expected: '2.4.1-canary.202610290910' },
    { plannedNext: '2.5.0', packageVersion: '2.4.0', stableLatest: '2.4.0', builtAt: '2026-10-31T00:43:00Z', expected: '2.5.0-canary.202610310043' },
    { plannedNext: '2.4.1', packageVersion: '2.4.0', stableLatest: '2.4.0', builtAt: '2026-11-01T00:43:00Z', expected: '2.5.0-canary.202611010043' },
    { plannedNext: null, packageVersion: '2.4.0', stableLatest: '2.4.0', builtAt: '2026-11-02T00:43:00Z', expected: '2.5.0-canary.202611020043' },
  ];
  let previousCanary = null;
  for (const step of timeline) {
    const version = computeCanaryVersion({ ...step, previousCanary, builtAt: at(step.builtAt) });
    assert.equal(version, step.expected);
    if (previousCanary !== null) assert.ok(compareCanaryVersions(version, previousCanary) > 0);
    previousCanary = version;
  }
});

await test('parseCanaryVersion accepts only <x.y.z>-canary.<12 digits>', () => {
  assert.deepEqual(parseCanaryVersion('2.4.0-canary.202610260043'), { base: '2.4.0', stamp: '202610260043' });
  for (const bad of ['2.4.0', '2.4-canary.202610260043', '1.5.2.3-canary.202610260043', '02.4.0-canary.202610260043', '2.4.0-canary.2026102600', '2.4.0-canary.202610260043.1', '2.4.0+canary.202610260043']) {
    assert.equal(parseCanaryVersion(bad), null, bad);
  }
});

await test('latestCanaryFromTags orders by base, then by timestamp, and ignores other tags', () => {
  assert.equal(latestCanaryFromTags([]), null);
  assert.equal(latestCanaryFromTags([
    '@moonshot-ai/kimi-code@2.10.0-canary.202601010000',
    '@moonshot-ai/kimi-code@2.9.0-canary.202612310000',
    '@moonshot-ai/kimi-code@2.10.0-canary.202601020000',
    '@moonshot-ai/kimi-code@3.0.0',
    '@moonshot-ai/kimi-code-sdk@9.0.0-canary.202601010000',
  ]), '2.10.0-canary.202601020000');
});

await test('pickNewestGreenCommit follows first-parent order, not run order', () => {
  assert.equal(pickNewestGreenCommit(['c', 'b', 'a'], ['a', 'b']), 'b');
  assert.equal(pickNewestGreenCommit(['c'], ['a']), null);
});

await test('buildCanaryRecord is a valid channel pointer for the client', () => {
  const record = buildCanaryRecord({
    version: '2.4.0-canary.202610260043',
    commit: 'a'.repeat(40),
    ref: 'main',
    trigger: 'nightly',
    builtAt: '2026-10-26T00:43:00.000Z',
    publishedAt: '2026-10-26T01:10:00.000Z',
    changes: ['Add the /foo command.'],
  });
  assert.equal(parseCanaryVersion(record.version)?.base, '2.4.0');
  assert.ok(Number.isFinite(Date.parse(record.publishedAt)));
  assert.deepEqual(record.rollout, []);
  assert.throws(() => buildCanaryRecord({ ...record, publishedAt: undefined }), /publishedAt/);
  assert.throws(() => buildCanaryRecord({ ...record, version: '2.4.0' }), /invalid canary version/);
});

await test('canaryChanges lists new CLI changesets only', () => {
  const current = new Map([
    ['b-new.md', '---\n"@moonshot-ai/kimi-code": minor\n---\n\nAdd the /foo command.\nRun /foo.\n'],
    ['a-old.md', '---\n"@moonshot-ai/kimi-code": patch\n---\n\nFix an old bug.\n'],
    ['c-internal.md', "---\n'@moonshot-ai/kimi-code-sdk': patch\n---\n\nInternal change.\n"],
    ['d-empty.md', '---\n---\n'],
  ]);
  assert.deepEqual(canaryChanges(current, new Set(['a-old.md'])), ['Add the /foo command. Run /foo.']);
  assert.deepEqual(parseChangeset('no frontmatter'), null);
});
