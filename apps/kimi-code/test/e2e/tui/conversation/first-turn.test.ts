import { say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { terminalFixtures, type TerminalFixtures } from '../support/terminal-session';

const test = base.extend<TerminalFixtures>(terminalFixtures);

test('[L0:tui.first-turn] submits the first prompt from the terminal and displays the answer', { tags: ['smoke'], timeout: 45_000 }, async ({ model, terminal }) => {
  const prompt = 'Hello terminal';
  const answer = 'Hello from the terminal.';
  model.script(say(answer));
  await terminal.type(prompt);
  await terminal.waitForText(prompt);
  terminal.press('Enter');
  await terminal.waitForText(answer);
  await terminal.waitForTurnToFinish();
  expect(model.requests('main').map(request => request.firstUserText)).toEqual([prompt]);
});
