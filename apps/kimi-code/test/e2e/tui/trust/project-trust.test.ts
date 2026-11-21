import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test as base } from 'vitest';

import { terminalLaunchFixtures, type TerminalLaunchFixtures } from '../support/terminal-session';

const test = base.extend<TerminalLaunchFixtures>(terminalLaunchFixtures);

const UNTRUSTED = { KIMI_CODE_TRUST_WORKSPACE: undefined };
const COLUMNS = 160;

async function createRepositoryWithWorktree(main: string, worktree: string): Promise<void> {
  const exec = promisify(execFile);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: main });
  await exec(
    'git',
    ['-c', 'user.email=trust-journey@example.com', '-c', 'user.name=Trust Journey', 'commit', '-q', '--allow-empty', '-m', 'initial'],
    { cwd: main },
  );
  await exec('git', ['worktree', 'add', '-q', '-b', 'fix', worktree], { cwd: main });
}

test('asks once to trust a repository project and starts its new worktree without asking again', { timeout: 90_000 }, async ({ launchTerminal, testHome }) => {
  const main = testHome.workspace;
  const worktree = join(testHome.root, 'workspace-fix');
  await createRepositoryWithWorktree(main, worktree);

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
  await createRepositoryWithWorktree(main, join(testHome.root, 'workspace-fix'));
  await mkdir(subdir);

  const inSubdir = await launchTerminal({ cwd: subdir, env: UNTRUSTED, columns: COLUMNS, readyText: 'Trust this project?' });
  const prompt = await inSubdir.viewport();
  expect(prompt).toContain(` ${main}\n`);
  expect(prompt).not.toContain(subdir);
  inSubdir.press('Enter');
  await inSubdir.waitForText(inSubdir.modelName);
});
