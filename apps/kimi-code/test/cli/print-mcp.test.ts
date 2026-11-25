import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGitWorktree,
  kimiCliCommand,
  kimiCliEnv,
  kimiServiceStubs,
  mergeKimiConfig,
  TestProcess,
  TIMEOUTS,
  until,
  writeKimiConfig,
  type TestHome,
} from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, held, say, type FakeModel } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

const test = base.extend<HomeFixtures & ModelFixtures>({ ...homeFixtures(), ...modelFixtures() });

const SERVER = fileURLToPath(new URL('../../../../packages/agent-core-v2/test/mcpCore/fixtures/cwd-stdio-server.mjs', import.meta.url));

type Checkout = 'main' | 'worktree';
type Place = Checkout | 'src' | 'worktreeSrc';

interface PrintSession {
  readonly session: string;
  readonly cwd: Place;
  readonly environment?: 'local' | 'loopback';
  readonly environmentCwd?: Place;
  readonly relativePath?: true;
  readonly servers: Checkout;
}

const PROJECT_SERVERS: Readonly<Record<Checkout, readonly string[]>> = { main: ['home', 'shared'], worktree: ['worktree'] };

const SESSIONS: readonly PrintSession[] = [
  { session: 'in the main checkout', cwd: 'main', servers: 'main' },
  { session: 'in a subdirectory', cwd: 'src', servers: 'main' },
  { session: 'in a worktree', cwd: 'worktree', servers: 'worktree' },
  { session: 'in a subdirectory of a worktree', cwd: 'worktreeSrc', servers: 'worktree' },
  { session: 'on the local environment', cwd: 'src', environment: 'local', servers: 'main' },
  { session: 'pinned to a subdirectory', cwd: 'main', environment: 'local', environmentCwd: 'src', servers: 'main' },
  { session: 'pinned to a relative subdirectory', cwd: 'main', environment: 'local', environmentCwd: 'src', relativePath: true, servers: 'main' },
  { session: 'pinned to a worktree', cwd: 'main', environment: 'local', environmentCwd: 'worktree', servers: 'worktree' },
  { session: 'in a subdirectory, run remotely', cwd: 'src', environment: 'loopback', environmentCwd: 'worktree', servers: 'main' },
  { session: 'in a worktree, run remotely', cwd: 'worktree', environment: 'loopback', environmentCwd: 'main', servers: 'worktree' },
];

async function preparePrint(model: FakeModel, testHome: TestHome) {
  await model.listen();
  const root = await realpath(testHome.root);
  const dirs: Readonly<Record<Place, string>> = {
    main: join(root, 'workspace'),
    src: join(root, 'workspace', 'src'),
    worktree: join(root, 'workspace-fix'),
    worktreeSrc: join(root, 'workspace-fix', 'src'),
  };
  const { entry, imports = [], env = {} } = kimiCliCommand();
  await writeKimiConfig(testHome.dataDir, mergeKimiConfig(fakeModelConfig(model), {
    extra: {
      environments: {
        loopback: {
          command: process.execPath,
          args: [...imports.flatMap((specifier) => ['--import', specifier]), entry, 'exec-server', '--listen', 'stdio'],
          env,
        },
      },
    },
  }));
  await createGitWorktree({ main: dirs.main, worktree: dirs.worktree });
  const startLog = join(testHome.root, 'mcp-starts.log');
  await writeFile(startLog, '');
  const writeMcpJson = async (file: string, name: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      mcpServers: { [name]: { command: process.execPath, args: [SERVER, name], env: { KIMI_TEST_MCP_START_LOG: startLog } } },
    }));
  };
  await writeMcpJson(join(testHome.dataDir, 'mcp.json'), 'user');
  await writeMcpJson(join(dirs.main, '.mcp.json'), 'shared');
  await writeMcpJson(join(dirs.main, '.kimi-code', 'mcp.json'), 'home');
  await writeMcpJson(join(dirs.worktree, '.kimi-code', 'mcp.json'), 'worktree');
  for (const subdir of [dirs.src, dirs.worktreeSrc]) await writeMcpJson(join(subdir, '.kimi-code', 'mcp.json'), 'planted');
  return {
    dirs,
    started: async () => (await readFile(startLog, 'utf8')).split('\n').filter(Boolean).toSorted(),
    start: ({ cwd, environment, environmentCwd, relativePath }: PrintSession, set: Readonly<Record<string, string | undefined>> = {}) =>
      TestProcess.start({
        label: 'kimi -p',
        command: kimiCliCommand(),
        args: [
          ...(environment === undefined ? [] : ['--environment', environment]),
          ...(environmentCwd === undefined
            ? []
            : ['--environment-cwd', relativePath ? relative(dirs[cwd], dirs[environmentCwd]) : dirs[environmentCwd]]),
          '-p',
          'hello',
        ],
        cwd: dirs[cwd],
        env: kimiCliEnv(testHome, set),
        logDir: testHome.root,
        fetchStubs: kimiServiceStubs(),
      }),
  };
}

test.for(SESSIONS)('kimi -p starts the MCP servers of a session $session once and no others', { timeout: 90_000 }, async (session, { model, testHome }) => {
  model.script(held('answer', say('done')));
  const { dirs, started, start } = await preparePrint(model, testHome);
  const servers = [...PROJECT_SERVERS[session.servers], 'user'];

  const cli = start(session);
  await model.hold('answer').reached({ timeoutMs: TIMEOUTS.server });
  await until('every expected MCP server started', async () => {
    const lines = await started();
    return servers.every((name) => lines.some((line) => line.startsWith(`${name} `)));
  }, { timeoutMs: TIMEOUTS.server });
  model.hold('answer').release();
  const exit = await cli.closed;

  expect(exit.code, cli.stderrTail()).toBe(0);
  expect(await started()).toEqual(servers.map((name) => `${name} ${dirs[session.servers]}`).toSorted());
});

test.for(SESSIONS)('kimi -p names the project MCP servers it skips for a session $session of an untrusted project', { timeout: 90_000 }, async (session, { model, testHome }) => {
  model.script(say('done'));
  const { started, start } = await preparePrint(model, testHome);
  const skipped = PROJECT_SERVERS[session.servers].map((name) => `${name} (stdio: ${process.execPath} ${SERVER} ${name})`);

  const cli = start(session, { KIMI_CODE_TRUST_WORKSPACE: undefined });
  const exit = await cli.closed;

  expect(exit.code, cli.stderrTail()).toBe(0);
  expect(cli.stderrTail()).toContain(
    `skipped ${skipped.length} project-level MCP ${skipped.length === 1 ? 'server' : 'servers'}: ${skipped.join(', ')}.\n`,
  );
  expect((await started()).filter((line) => !line.startsWith('user '))).toEqual([]);
});
