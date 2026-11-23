import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suite = join(root, 'apps/desktop/tests/perf/history-window');
const parent = resolve(process.argv[2] ?? join(root, '.tmp/history-perf'));
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(join(parent, 'run-'));
console.log(`History performance evidence: ${dir}`);
const electron = createRequire(new URL('../apps/desktop/package.json', import.meta.url))('electron');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PERF_') && key !== 'ELECTRON_RUN_AS_NODE'));
function run(command, args, extra = {}) {
  const child = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 180_000, env: { ...env, ...extra } });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`History benchmark failed (exit=${child.status}, signal=${child.signal})`);
}
const full = join(dir, 'full');
const windowed = join(dir, 'windowed');
run(process.execPath, [join(suite, 'build.mjs'), 'baseline', full]);
run(process.execPath, [join(suite, 'build.mjs'), 'current', windowed]);
const samples = [];
for (let i = 0; i < 3; i++) {
  const path = join(dir, `sample-${i + 1}.json`);
  run(electron, [join(suite, 'run.cjs'), path, ...(i % 2 === 0 ? [full, windowed] : [windowed, full])], {
    PERF_HEADLESS: '1', PERF_PROFILE_DIR: join(dir, `profile-${i}`), HISTORY_COUNT: '240',
  });
  const { results } = JSON.parse(readFileSync(path, 'utf8'));
  if (results.length !== 2) throw new Error('Expected both history variants');
  for (const result of results) {
    if (result.count !== 240 || result.errors.length || !(result.openMs > 0) || !(result.heapAfter > result.heapBefore)) {
      throw new Error(`Incomplete history sample: ${path}`);
    }
    if (result.variant === full && result.mountedMessages !== result.count) throw new Error('Unwindowed control did not mount all messages');
    if (result.variant === windowed && (result.mountedMessages > 32 || result.scrollMessages > 32 || !result.mountedMessages || !result.scrollMessages)) {
      throw new Error(`Windowed history mount budget exceeded or empty: ${path}`);
    }
  }
  samples.push(results);
}
function medians(variant) {
  const rows = samples.map(results => results.find(row => row.variant === variant));
  const median = values => values.toSorted((a, b) => a - b)[1];
  return { openMs: median(rows.map(r => r.openMs)), heapGrowthBytes: median(rows.map(r => r.heapAfter - r.heapBefore)) };
}
const result = { revision: process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), full: medians(full), windowed: medians(windowed) };
writeFileSync(join(dir, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
if (result.windowed.openMs >= result.full.openMs || result.windowed.heapGrowthBytes >= result.full.heapGrowthBytes) {
  throw new Error('240-message history must open faster and grow less measured JS heap than the unwindowed control (three-run medians)');
}
