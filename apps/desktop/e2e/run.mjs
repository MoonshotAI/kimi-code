import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { playwrightEnv } from './mode-env.ts';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2).filter(arg => arg !== '--');
const headless = process.env.npm_lifecycle_event === 'e2e:headless';
const build = !args.includes('--no-build');
const playwrightArgs = args.filter(arg => arg !== '--no-build');

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: desktopDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hasXvfb() {
  return process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
}

const playwright = ['exec', 'playwright', 'test', '-c', 'e2e', ...playwrightArgs];
if (build) run('pnpm', ['run', 'build']);
const env = playwrightEnv(headless, process.env);
if (hasXvfb() && (headless || !process.env.DISPLAY)) run('xvfb-run', ['--auto-servernum', '--server-args=-screen 0 1920x1080x24', 'pnpm', ...playwright], env);
else run('pnpm', playwright, env);
