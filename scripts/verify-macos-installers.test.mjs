import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./verify-macos-installers.sh', import.meta.url));
const mockTool = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TOOL_LOG, JSON.stringify({ tool, args }) + '\n');
const stage = args.some(arg => arg.includes('/zip/')) ? 'zip' : 'dmg';
if (process.env.FAIL_AT === tool + ':' + args[0] || process.env.FAIL_AT === tool + ':' + args[0] + ':' + stage) process.exit(9);
if (tool === 'hdiutil' && args[0] === 'attach') {
  fs.mkdirSync(path.join(args[args.indexOf('-mountpoint') + 1], 'Kimi Code Preview.app'));
}
if (tool === 'ditto') {
  fs.mkdirSync(path.join(args.at(-1), 'Kimi Code Preview.app'), { recursive: true });
}
`;

function fixture(t, failAt = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-verification-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const dist = path.join(dir, 'dist with spaces');
  fs.mkdirSync(bin);
  fs.mkdirSync(dist);
  for (const name of ['hdiutil', 'codesign', 'xcrun', 'spctl', 'ditto']) {
    fs.writeFileSync(path.join(bin, name), mockTool, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dist, 'KimiCodePreview-test.dmg'), 'fixture');
  fs.writeFileSync(path.join(dist, 'KimiCodePreview-test.zip'), 'fixture');
  const log = path.join(dir, 'tools.log');
  return {
    dist,
    run: () => spawnSync('bash', [script, dist], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, TOOL_LOG: log, FAIL_AT: failAt },
    }),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

void test('validates the applications extracted from both installers before succeeding', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  for (const tool of ['codesign', 'xcrun', 'spctl']) {
    const checks = calls.filter(call => call.tool === tool);
    assert.equal(checks.length, 2);
    assert.match(checks[0].args.at(-1), /\/dmg\/Kimi Code Preview\.app$/);
    assert.match(checks[1].args.at(-1), /\/zip\/Kimi Code Preview\.app$/);
  }
  const signature = calls.find(call => call.tool === 'codesign');
  assert.ok(signature.args.includes('--deep'));
  assert.ok(signature.args.includes('--strict'));
  assert.match(signature.args[signature.args.indexOf('-R') + 1], /1\.2\.840\.113635\.100\.6\.1\.13/);
  assert.ok(signature.args[signature.args.indexOf('-R') + 1].startsWith('='));
  assert.ok(calls.find(call => call.args[0] === 'attach').args.includes('-readonly'));
  assert.equal(calls.filter(call => call.args[0] === 'detach').length, 1);
});

for (const failure of [
  'hdiutil:verify', 'hdiutil:attach', 'ditto:-x',
  'codesign:--verify:dmg', 'codesign:--verify:zip',
  'xcrun:stapler:dmg', 'xcrun:stapler:zip',
  'spctl:--assess:dmg', 'spctl:--assess:zip',
]) {
  void test(`fails closed when ${failure} fails`, t => {
    const f = fixture(t, failure);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /contain valid/);
    if (/^(codesign|xcrun|spctl):.*:dmg$/.test(failure)) {
      assert.equal(f.calls().at(-1).args[0], 'detach');
      assert.ok(!f.calls().some(call => call.tool === 'ditto'));
    }
  });
}

for (const mode of ['missing-dmg', 'missing-zip', 'extra-dmg', 'extra-zip']) {
  void test(`rejects ${mode} before verification`, t => {
    const f = fixture(t);
    const [action, extension] = mode.split('-');
    if (action === 'missing') fs.unlinkSync(path.join(f.dist, `KimiCodePreview-test.${extension}`));
    else fs.writeFileSync(path.join(f.dist, `extra.${extension}`), 'fixture');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one DMG and one ZIP/);
    assert.equal(f.calls().length, 0);
  });
}
