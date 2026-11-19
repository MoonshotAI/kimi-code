import { say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { terminalFixtures, type TerminalFixtures } from './terminal-session';

const test = base.extend<TerminalFixtures>(terminalFixtures);

test('distinguishes pasted drafts from submitted text and explains a missing screen state', { timeout: 45_000 }, async ({ terminal, model }) => {
  const draft = 'An unsent pasted draft';
  terminal.paste(draft);
  await terminal.waitForText(draft);
  terminal.press('Ctrl+C');
  await terminal.waitForTextGone(draft);
  expect(model.requests('main')).toHaveLength(0);

  const lines = Array.from({ length: 48 }, (_, i) => `Output line ${i + 1}.`);
  model.script(say([...lines, 'Diagnostic reply.'].join('\n\n')));
  terminal.paste('Send this question');
  terminal.press('Enter');
  await terminal.waitForText('Diagnostic reply.');
  expect(await terminal.viewport()).not.toContain(lines[0]!);
  expect(await terminal.scrollback()).toContain(lines[0]!);
  await expect(terminal.waitForText('Missing screen marker', 100)).rejects.toThrow(
    /Missing screen marker.*recent input=.*Send this question.*Screen:.*Diagnostic reply\..*Stderr:.*Model requests:.*"lane":"main"/s,
  );
});
