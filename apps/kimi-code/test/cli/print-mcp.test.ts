import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { kimiCliCommand, kimiCliEnv, kimiServiceStubs, TestProcess, TIMEOUTS, until, writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, held, say } from '@moonshot-ai/testkit/model';
import { homeFixtures, modelFixtures, type HomeFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

const test = base.extend<HomeFixtures & ModelFixtures>({ ...homeFixtures(), ...modelFixtures() });

const SERVER = fileURLToPath(new URL('../../../../packages/agent-core-v2/test/mcpCore/fixtures/cwd-stdio-server.mjs', import.meta.url));

test.for([
  { session: 'that follows it', args: [] },
])('kimi -p starts each MCP server of the project once, in the project directory, for a session $session', { timeout: 90_000 }, async ({ args }, { model, testHome }) => {
  await model.listen();
  model.script(held('answer', say('done')));
  await writeKimiConfig(testHome.dataDir, fakeModelConfig(model));
  const root = await realpath(testHome.workspace);
  const startLog = join(testHome.root, 'mcp-starts.log');
  const started = async () => (await readFile(startLog, 'utf8')).split('\n').filter(Boolean).toSorted();
  const writeServer = async (file: string, name: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({
      mcpServers: { [name]: { command: process.execPath, args: [SERVER, name], env: { KIMI_TEST_MCP_START_LOG: startLog } } },
    }));
  };
  await writeFile(startLog, '');
  await writeServer(join(testHome.dataDir, 'mcp.json'), 'user');
  await writeServer(join(root, '.kimi-code', 'mcp.json'), 'project');
  await writeServer(join(root, 'src', '.kimi-code', 'mcp.json'), 'nested');

  const cli = TestProcess.start({
    label: 'kimi -p',
    command: kimiCliCommand(),
    args: [...args, '-p', 'hello'],
    cwd: root,
    env: kimiCliEnv(testHome),
    logDir: testHome.root,
    fetchStubs: kimiServiceStubs(),
  });
  await model.hold('answer').reached({ timeoutMs: TIMEOUTS.server });
  await until('both MCP servers of the project started', async () => new Set(await started()).size === 2, { timeoutMs: TIMEOUTS.server });
  model.hold('answer').release();
  const exit = await cli.closed;

  expect(exit.code, cli.stderrTail()).toBe(0);
  expect(await started()).toEqual([`project ${root}`, `user ${root}`]);
});
