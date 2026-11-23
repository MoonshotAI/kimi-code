import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/set-mac-update-minimum-system-version.mjs');
const builderConfig = resolve('apps/desktop/electron-builder.config.cjs');
const DARWIN_FLOOR_BY_MACOS_MAJOR = { 13: '22.0.0', 14: '23.0.0', 15: '24.0.0', 26: '25.0.0', 27: '27.0.0' };

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'mac-update-minimum-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const channel of ['latest', 'canary']) {
  void test(`${channel}: writes the Darwin update floor exactly once`, () => {
    withDirectory((directory) => {
      const manifest = join(directory, `${channel}-mac.yml`);
      writeFileSync(manifest, 'version: 1.2.1\nfiles: []\n');
      for (let index = 0; index < 2; index++) {
        const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(readFileSync(manifest, 'utf8'), 'version: 1.2.1\nfiles: []\nminimumSystemVersion: 22.0.0\n');
    });
  });
}

void test('writes the Darwin floor that matches the packaged minimum macOS version', () => {
  const macosMajor = Number(createRequire(import.meta.url)(builderConfig).mac.minimumSystemVersion.split('.')[0]);
  const expected = DARWIN_FLOOR_BY_MACOS_MAJOR[macosMajor];
  assert.ok(expected, `No Darwin floor is mapped for macOS ${macosMajor}; map it here and update the script`);
  withDirectory((directory) => {
    const manifest = join(directory, 'latest-mac.yml');
    writeFileSync(manifest, 'version: 1.2.1\n');
    const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(manifest, 'utf8'), `version: 1.2.1\nminimumSystemVersion: ${expected}\n`);
  });
});

void test('rejects a conflicting update floor', () => {
  withDirectory((directory) => {
    writeFileSync(join(directory, 'latest-mac.yml'), 'minimumSystemVersion: 21.0.0\n');
    const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected macOS update minimum system version/);
  });
});

void test('rejects a missing update manifest', () => {
  withDirectory((directory) => {
    const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected exactly one macOS update manifest/);
  });
});

void test('rejects multiple update manifests', () => {
  withDirectory((directory) => {
    writeFileSync(join(directory, 'latest-mac.yml'), '');
    writeFileSync(join(directory, 'canary-mac.yml'), '');
    const result = spawnSync(process.execPath, [script, directory], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected exactly one macOS update manifest/);
  });
});
