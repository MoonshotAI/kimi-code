import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createGitWorktree, kimiCliCommand, kimiCliEnv, TestProcess } from '@moonshot-ai/testkit/fixtures';
import { KapProcess } from '@moonshot-ai/testkit/kap';
import { expect, onTestFinished, test as base } from 'vitest';

import { cliFetchStubs, terminalLaunchFixtures, type TerminalLaunchFixtures } from '../support/terminal-session';

const test = base.extend<TerminalLaunchFixtures>(terminalLaunchFixtures);

const UNTRUSTED = { KIMI_CODE_TRUST_WORKSPACE: undefined };
const COLUMNS = 160;

test('asks once to trust a repository project and starts its new worktree without asking again', { timeout: 90_000 }, async ({ launchTerminal, testHome }) => {
  const main = testHome.workspace;
  const worktree = join(testHome.root, 'workspace-fix');
  await createGitWorktree({ main, worktree });

  const inMain = await launchTerminal({ cwd: main, env: UNTRUSTED, columns: COLUMNS, readyText: 'Trust this project?' });
  const prompt = await inMain.viewport();
  expect(prompt).toContain(` ${main}\n`);
  expect(prompt).toContain('Trust is remembered for this project');
  inMain.press('Enter');
  await inMain.waitForText(inMain.modelName);
  await inMain.close();

  const inWorktree = await launchTerminal({ cwd: worktree, env: UNTRUSTED, columns: COLUMNS });
  expect(await inWorktree.viewport()).not.toContain('Trust this project?');
});

test('asks to trust the repository project with its main checkout when first started in a subdirectory', { timeout: 60_000 }, async ({ launchTerminal, testHome }) => {
  const main = testHome.workspace;
  const subdir = join(main, 'src');
  await createGitWorktree({ main, worktree: join(testHome.root, 'workspace-fix') });
  await mkdir(subdir);

  const inSubdir = await launchTerminal({ cwd: subdir, env: UNTRUSTED, columns: COLUMNS, readyText: 'Trust this project?' });
  const prompt = await inSubdir.viewport();
  expect(prompt).toContain(` ${main}\n`);
  expect(prompt).not.toContain(subdir);
  inSubdir.press('Enter');
  await inSubdir.waitForText(inSubdir.modelName);
});

test('asks about the managed project of a resumed session even though the repository project of its directory is trusted', { timeout: 120_000 }, async ({ launchTerminal, testHome }) => {
  const main = testHome.workspace;
  const worktree = join(testHome.root, 'workspace-fix');
  await createGitWorktree({ main, worktree });
  const inMain = await launchTerminal({ cwd: main, env: UNTRUSTED, columns: COLUMNS, readyText: 'Trust this project?' });
  inMain.press('Enter');
  await inMain.waitForText(inMain.modelName);
  await inMain.close();
  const server = await KapProcess.start({ home: testHome, env: UNTRUSTED });
  let sessionId: string;
  try {
    const project = await server.rest.post<{ id: string }>('/api/v1/workspaces', { root: worktree, name: 'Managed' });
    ({ id: sessionId } = await server.rest.post<{ id: string }>('/api/v1/sessions', { workspace_id: project.id, metadata: { cwd: worktree } }));
  } finally {
    await server.close();
  }
  const resume = { cwd: worktree, args: ['-r', sessionId], env: UNTRUSTED, columns: COLUMNS };

  const untrusted = await launchTerminal({ ...resume, readyText: 'Trust this project?' });
  expect(await untrusted.viewport()).toContain(` ${worktree}\n`);
  untrusted.press('Enter');
  await untrusted.waitForText(untrusted.modelName);
  await untrusted.close();

  const trusted = await launchTerminal(resume);
  expect(await trusted.viewport()).not.toContain('Trust this project?');
});

test('stops with the reason instead of asking when the trust record of the project cannot be read', { timeout: 90_000 }, async ({ launchTerminal, testHome }) => {
  const first = await launchTerminal({ env: UNTRUSTED, columns: COLUMNS, readyText: 'Trust this project?' });
  first.press('Enter');
  await first.waitForText(first.modelName);
  await first.close();
  const records = join(testHome.dataDir, 'workspace-trust');
  for (const record of await readdir(records)) await writeFile(join(records, record), '{not json');

  const cli = TestProcess.start({
    label: 'CLI',
    command: kimiCliCommand(),
    cwd: testHome.workspace,
    env: kimiCliEnv(testHome, UNTRUSTED),
    logDir: testHome.root,
    stdin: true,
    fetchStubs: cliFetchStubs(),
  });
  onTestFinished(async () => {
    if (!cli.exited) await cli.forceKill();
  });

  expect((await cli.closed).code).toBe(1);
  expect(cli.stderrTail()).toContain('Could not check whether this project is trusted: failed to decode workspace-trust/');
});
