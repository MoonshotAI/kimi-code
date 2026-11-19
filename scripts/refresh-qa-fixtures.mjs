import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [kind, ...rest] = process.argv.slice(2);
if (process.env.CI || rest.length || !['replay', 'schema'].includes(kind)) {
  throw new Error('Run locally: pnpm qa:refresh replay | pnpm qa:refresh schema');
}
const run = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', `tests/scenarios/${kind}.test.ts`,
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', env: { ...process.env, TESTKIT_REFRESH: kind },
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
