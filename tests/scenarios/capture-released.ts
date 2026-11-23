import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { createTestHome, kimiCliEnv, kimiServiceStubs, TestProcess, TIMEOUTS, writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { createFakeModel, fakeModelConfig, say } from '@moonshot-ai/testkit/model';

import {
  corpusDirectory,
  RELEASED_ANSWER,
  RELEASED_PACKAGE,
  RELEASED_PROMPT,
  RELEASED_WORKSPACE,
  sha256,
  templateOf,
  type CorpusManifest,
} from './support/released-corpus';

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

async function onlyEntry(dir: string, matches: (name: string) => boolean): Promise<string> {
  const names = (await readdir(dir)).filter(matches);
  if (names.length !== 1) throw new Error(`Expected exactly one matching entry in ${dir}, found ${names.length}: ${names.join(', ')}`);
  return names[0]!;
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const [version] = positionals;
if (version === undefined || positionals.length !== 1 || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Usage: pnpm qa:capture-released <released version> [--out <directory>]');
}
if (process.env['CI'] !== undefined && process.env['CI'] !== '') throw new Error('Capture released corpora locally; CI only reads them');
const target = values.out ?? corpusDirectory(version);
if (existsSync(target)) throw new Error(`${target} already exists; a released corpus is never rewritten`);

const work = await createTestHome('capture-released');
const model = createFakeModel();
try {
  const spec = `${RELEASED_PACKAGE}@${version}`;
  const [packed] = JSON.parse(run('npm', ['pack', spec, '--json', '--pack-destination', work.root], work.root)) as { filename: string; integrity: string }[];
  const registered = JSON.parse(run('npm', ['view', spec, 'dist.integrity', '--json'], work.root)) as string;
  if (packed === undefined || packed.integrity !== registered) throw new Error(`The packed ${spec} does not match the registry integrity ${registered}`);
  run('npm', ['install', '--prefix', join(work.root, 'install'), '--ignore-scripts', '--no-audit', '--no-fund', join(work.root, packed.filename)], work.root);
  const entry = join(work.root, 'install', 'node_modules', ...RELEASED_PACKAGE.split('/'), 'dist', 'main.mjs');

  await model.listen();
  model.script(say(RELEASED_ANSWER));
  await writeKimiConfig(work.dataDir, fakeModelConfig(model, { type: 'openai' }));
  const workspace = join(work.root, RELEASED_WORKSPACE);
  await mkdir(workspace);
  const cli = TestProcess.start({
    label: spec,
    command: { entry },
    args: ['-p', RELEASED_PROMPT],
    cwd: workspace,
    env: kimiCliEnv(work, { TZ: 'UTC' }),
    logDir: work.root,
    fetchStubs: kimiServiceStubs(),
  });
  const timer = setTimeout(() => void cli.forceKill(), TIMEOUTS.server);
  const exit = await cli.closed.finally(() => clearTimeout(timer));
  if (exit.code !== 0) throw new Error(`${spec} did not finish the prompt\n${cli.describe()}`);
  const blocked = await cli.networkViolations();
  if (blocked.length > 0) throw new Error(`${spec} tried to reach non-loopback addresses: ${blocked.join(', ')}`);
  model.verify();

  const sessions = join(work.dataDir, 'sessions');
  const workspaceKey = await onlyEntry(sessions, (name) => name.startsWith(`wd_${RELEASED_WORKSPACE}_`));
  const sessionId = await onlyEntry(join(sessions, workspaceKey), (name) => name.startsWith('session_'));
  const session = `sessions/${workspaceKey}/${sessionId}`;
  const retained = ['projects.json', 'session_index.jsonl', `${session}/state.json`, `${session}/agents/main/wire.jsonl`];
  const paths = {
    dataDir: [...new Set([work.dataDir, await realpath(work.dataDir)])],
    workspace: [...new Set([workspace, await realpath(workspace)])],
  };
  const files: Record<string, string> = {};
  for (const file of retained) {
    const template = templateOf(await readFile(join(work.dataDir, file), 'utf8'), paths);
    await mkdir(dirname(join(target, file)), { recursive: true });
    await writeFile(join(target, file), template);
    files[file] = sha256(template);
  }
  const manifest: CorpusManifest = { writer: spec, integrity: registered, sessionId, files };
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(target, 'README.md'), [
    '# Released conversation fixture',
    '',
    `The npm distribution of ${spec} wrote this session. The package integrity in manifest.json comes from its registry entry and matched the downloaded package.`,
    '',
    `\`pnpm qa:capture-released ${version}\` installed the package without install scripts and ran its dist/main.mjs with \`-p '${RELEASED_PROMPT}'\` in an empty \`${RELEASED_WORKSPACE}\` workspace, with a temporary HOME, a separate KIMI_CODE_HOME, TZ=UTC and a loopback testkit provider that answered \`${RELEASED_ANSWER}\`. Only the project registry, session index, session state and main agent wire were kept.`,
    '',
    'The temporary data directory and workspace paths are replaced with {{DATA_DIR}} and {{WORKSPACE}}. Each manifest digest covers the committed template bytes. A released corpus is never rewritten; capture a new writer version into its own directory.',
    '',
  ].join('\n'));
  process.stdout.write(`Captured ${spec} into ${target}\n`);
} finally {
  await model.close();
  await work.remove();
}
