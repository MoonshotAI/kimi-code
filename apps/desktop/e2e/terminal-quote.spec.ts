import { expect } from './fixtures/app';
import { say } from './fixtures/model';
import {
  expectTerminalText,
  runInTerminal,
  selectTerminalLine,
  shellCommands as sh,
  shellEnv,
  terminalPanel,
  terminalTabs,
  readShellPid,
  terminalText,
  test,
  waitForPrompt,
} from './fixtures/terminal';
import { sidebarOf } from './fixtures/sessions';

const QUOTED = 'quote-me-from-the-terminal';
const PROMPT = 'What does this terminal line mean?';
const REPLY = 'It is a line your shell printed.';
const QUOTE_PILL = `[data-quote-text="${QUOTED}"]`;

test.use({ appEnv: shellEnv });

test('terminal output quoted into the composer reaches the model and the terminal follows its session', async ({ app, model }) => {
  const window = app.window;
  const panel = terminalPanel(window);
  const composer = window.getByRole('combobox', { name: 'Message input' });
  const transcript = window.getByRole('list').first();
  let shellPid = '';

  await test.step('the draft terminal prints a line', async () => {
    await window.getByRole('button', { name: 'Open terminal' }).click();
    await expect(panel).toBeVisible();
    await waitForPrompt(window);
    await runInTerminal(window, sh.echo(QUOTED));
    await expectTerminalText(window, new RegExp(`^${QUOTED}$`, 'm'));
    await runInTerminal(window, sh.shellPid('draft'));
    shellPid = await readShellPid(window, 'draft');
  });

  await test.step('selecting the line offers to add it to the chat', async () => {
    await selectTerminalLine(window, QUOTED);
    const addToChat = window.getByRole('menuitem', { name: 'Add to chat' });
    await expect(addToChat).toBeVisible();
    await expect(addToChat).toBeInViewport();
    await app.snapshot('selection-bubble');
    await addToChat.click();
    await expect(addToChat).toBeHidden();
    await expect(composer.locator(QUOTE_PILL)).toHaveCount(1);
    await app.snapshot('quote-in-composer');
  });

  await test.step('sending carries the quote to the model', async () => {
    model.script(say(REPLY));
    await composer.click();
    await window.keyboard.press('End');
    const next = model.requests().length;
    await window.keyboard.type(PROMPT);
    await window.keyboard.press('Enter');
    const request = await model.waitForRequest(next);
    const userText = request.userTextsSinceReply.join('\n');
    expect(userText).toContain(QUOTED);
    expect(userText).toContain(PROMPT);
    expect(userText.indexOf(QUOTED)).toBeLessThan(userText.indexOf(PROMPT));
    await expect(transcript.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(transcript.locator(QUOTE_PILL)).toHaveCount(1);
    await expect(composer.locator('[data-quote-text]')).toHaveCount(0);
  });

  await test.step('the draft terminal moves into the new session with the same shell', async () => {
    await app.sessionId();
    await expect(panel).toBeVisible();
    await expect(terminalTabs(window)).toHaveCount(1);
    await runInTerminal(window, sh.echo('session-line'));
    await expectTerminalText(window, /^session-line$/m);
    await runInTerminal(window, sh.shellPid('session'));
    expect(await readShellPid(window, 'session')).toBe(shellPid);
    await app.snapshot('session-with-terminal');
  });

  await test.step('a new draft gets its own terminal and the session keeps the old one', async () => {
    const sessionUrl = window.url();
    await window.getByRole('button', { name: /^New Session/ }).click();
    await expect.poll(() => window.url()).not.toBe(sessionUrl);
    await expect(panel).toBeHidden();
    await window.getByRole('button', { name: 'Open terminal' }).click();
    await expect(panel).toBeVisible();
    await waitForPrompt(window);
    expect(await terminalText(window)).not.toContain(QUOTED);
    await runInTerminal(window, sh.echo('draft-only-line'));
    await expectTerminalText(window, /^draft-only-line$/m);

    await sidebarOf(app).getByText(PROMPT).click();
    await expect.poll(() => window.url()).toBe(sessionUrl);
    await expect(panel).toBeVisible();
    await expectTerminalText(window, /^session-line$/m);
    expect(await terminalText(window)).not.toContain('draft-only-line');
  });

  await test.step('the quoted message survives a relaunch', async () => {
    const sessionUrl = window.url();
    await app.relaunch();
    const restored = app.window;
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
    if (restored.url() !== sessionUrl) await sidebar.getByText(PROMPT).click();
    await expect.poll(() => restored.url()).toBe(sessionUrl);
    const restoredTranscript = restored.getByRole('list').first();
    await expect(restoredTranscript.locator(QUOTE_PILL)).toHaveCount(1);
    await expect(restoredTranscript.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(terminalPanel(restored)).toBeHidden();
    await expect(restored.getByText('Opening session…')).toBeHidden();
    expect(model.requests()).toHaveLength(1);
    await app.snapshot('restored-quote');
  });
});
