import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createGitWorktree } from '@moonshot-ai/testkit/fixtures';
import { expect, test as base } from 'vitest';

import { terminalLaunchFixtures, type TerminalLaunchFixtures } from '../support/terminal-session';

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
