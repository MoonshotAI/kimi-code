import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createGitWorktree } from '@moonshot-ai/testkit/fixtures';
import { say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { terminalLaunchFixtures, type TerminalLaunchFixtures } from '../support/terminal-session';

const test = base.extend<TerminalLaunchFixtures>(terminalLaunchFixtures);

async function recordedDirectories(dataDir: string): Promise<readonly (string | undefined)[]> {
  const projects = join(dataDir, 'sessions');
  const states = (await readdir(projects, { recursive: true })).filter((entry) => /^[^\\/]+[\\/][^\\/]+[\\/]state\.json$/.test(entry));
  return Promise.all(states.map(async (entry) =>
    (JSON.parse(await readFile(join(projects, entry), 'utf8')) as { readonly environmentCwd?: string }).environmentCwd,
  ));
}

test.for([
  ['the main checkout follow their project', 'main'],
  ['a worktree stay in the worktree', 'worktree'],
] as const)('lets the first session and the one after /new in %s', { timeout: 60_000 }, async ([, place], { launchTerminal, model, testHome }) => {
  const layout = { main: testHome.workspace, worktree: join(testHome.root, 'workspace-fix') };
  await createGitWorktree(layout);
  const terminal = await launchTerminal({ cwd: layout[place] });
  const ask = async (answer: string) => {
    model.script(say(answer));
    await terminal.type('Hello');
    terminal.press('Enter');
    await terminal.waitForText(answer);
    await terminal.waitForTurnToFinish();
  };

  await ask('Answer before.');
  terminal.paste('/new');
  terminal.press('Enter');
  await terminal.waitForTextGone('Answer before.');
  await ask('Answer after.');
  await terminal.close();

  const directory = place === 'main' ? undefined : layout.worktree;
  expect(await recordedDirectories(testHome.dataDir)).toEqual([directory, directory]);
});
