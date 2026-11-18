import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./desktop-artifact-prefix.mjs', import.meta.url));
const run = (env) => spawnSync(process.execPath, [script], {
  encoding: 'utf8',
  env: { ...process.env, ARTIFACT_PREFIX: '', PREVIEW: 'false', CANARY: 'false', GITHUB_REF_NAME: 'main', ...env },
});

for (const [label, env, expected] of [
  ['preview feature branch', { PREVIEW: 'true', GITHUB_REF_NAME: 'qer/screenshot-annotation' }, 'kimi-code-preview-qer-screenshot-annotation'],
  ['canary branch', { CANARY: 'true', GITHUB_REF_NAME: 'qer/fix' }, 'kimi-code-canary-qer-fix'],
  ['regular manual build', {}, 'kimi-code-main'],
  ['release caller', { ARTIFACT_PREFIX: 'kimi-code-app' }, 'kimi-code-app'],
  ['manual override', { PREVIEW: 'true', ARTIFACT_PREFIX: 'team-test' }, 'team-test'],
  ['blank override', { PREVIEW: 'true', ARTIFACT_PREFIX: '  ' }, 'kimi-code-preview-main'],
  ['unsafe branch characters', { GITHUB_REF_NAME: 'feature/a:b*?c' }, 'kimi-code-feature-a-b-c'],
  ['empty sanitized branch', { GITHUB_REF_NAME: '截图' }, 'kimi-code-ref'],
  ['long branch', { GITHUB_REF_NAME: 'a'.repeat(300) }, `kimi-code-${'a'.repeat(160)}`],
]) {
  test(label, () => {
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `prefix=${expected}\n`);
  });
}

for (const prefix of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'ok\nprefix=other', 'a'.repeat(201)]) {
  test(`rejects invalid override ${JSON.stringify(prefix)}`, () => {
    const result = run({ ARTIFACT_PREFIX: prefix });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Artifact prefix must/);
  });
}
