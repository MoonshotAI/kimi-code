import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OXLINT = path.join(ROOT, 'node_modules/oxlint/bin/oxlint');
const PLUGIN = path.join(ROOT, 'scripts/no-crypto-random-uuid-lint-plugin.mjs');

function lint(source, extension = 'ts') {
  const directory = mkdtempSync(path.join(tmpdir(), 'kimi-uuid-lint-'));
  try {
    const file = path.join(directory, `fixture.${extension}`);
    const config = path.join(directory, 'config.json');
    writeFileSync(file, source);
    writeFileSync(config, JSON.stringify({
      jsPlugins: [PLUGIN],
      rules: { 'kimi/no-crypto-random-uuid': 'error' },
    }));
    let output;
    try {
      output = execFileSync(process.execPath, [OXLINT, '--config', config, '--format', 'json', file], { encoding: 'utf8' });
    } catch (error) {
      if (error.status !== 1) throw error;
      output = error.stdout;
    }
    return JSON.parse(output).diagnostics.filter((diagnostic) => diagnostic.code === 'kimi(no-crypto-random-uuid)');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void test('reports direct, optional, computed, and destructured crypto randomUUID usage', () => {
  const diagnostics = lint(`
    crypto.randomUUID();
    globalThis.crypto?.randomUUID?.();
    window.crypto['randomUUID']();
    const { randomUUID } = crypto;
  `);
  assert.equal(diagnostics.length, 4);
  for (const diagnostic of diagnostics) {
    assert.match(diagnostic.message, /use v4 from uuid instead/);
  }
});

void test('allows Node crypto, uuid, custom objects, and test spies', () => {
  const diagnostics = lint(`
    import { randomUUID } from 'node:crypto';
    import { v4 } from 'uuid';
    randomUUID();
    v4();
    const custom = { randomUUID: () => 'custom' };
    custom.randomUUID();
    vi.spyOn(crypto, 'randomUUID');
  `);
  assert.deepEqual(diagnostics, []);
});

void test('checks Vue script blocks', () => {
  const diagnostics = lint(`<script setup lang="ts">
    const id = crypto.randomUUID();
  </script>`, 'vue');
  assert.equal(diagnostics.length, 1);
});
