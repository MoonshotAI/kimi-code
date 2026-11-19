import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TESTS = {
  replay: 'tests/scenarios/replay.test.ts',
  schema: 'packages/kap-server/test/apiSurface.test.ts',
};

const [kind, ...rest] = process.argv.slice(2);
if (process.env.CI || rest.length || !Object.hasOwn(TESTS, kind)) {
  throw new Error(`Run locally: ${Object.keys(TESTS).map((name) => `pnpm qa:refresh ${name}`).join(' | ')}`);
}
const run = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', TESTS[kind],
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', env: { ...process.env, TESTKIT_REFRESH: kind },
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
