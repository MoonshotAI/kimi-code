import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bash as callBash, say as reply } from '@moonshot-ai/testkit/model';

import { expect, test, testWithProvider } from './fixtures/app';
import { cardOutput, gatedLoop, gateFile, readyFile, toolCard } from './fixtures/bash-card';
import { captureClipboardWrites } from './fixtures/clipboard';
import { bash, messageProblems, say, textOf } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

test.use({ permissionMode: 'yolo' });

test.describe('Bash path resolution', () => {
  test.use({ appEnv: process.platform === 'win32' ? { HOME: undefined, HOMEDRIVE: '', HOMEPATH: '' } : {} });

  testWithProvider('Bash reads files in the workspace and the user home', async ({ app, provider, scratch }) => {
    await writeFile(join(app.workspace, 'workspace marker.txt'), 'from the workspace\n');
    await writeFile(join(scratch, 'os-home', 'home marker.txt'), 'from the user profile\n');
    const readMarkers = 'cat "workspace marker.txt" && cd ~ && cat "home marker.txt"';
    const command = process.platform === 'win32' ? `test -f /source-manifest.json && ${readMarkers}` : readMarkers;
    provider.script(callBash(command), reply('Read both files.'));
    await app.submit('Read both markers with Bash');
    const followup = await provider.lane('main').waitForRequest(1);
    expect(followup.texts('tool').join('\n')).toContain('from the workspace\nfrom the user profile');
    await expect(app.window.getByRole('list').first().getByText('Read both files.', { exact: true })).toBeVisible();
  });
});

const STREAM = gatedLoop('stream', ['stream-line-1', 'stream-line-2'], ['stream-line-3', 'stream-line-4']);
const FAIL = 'echo boom-on-stderr >&2; exit 3';
const BIG = 'seq -f big-%g 1 5000';
const STOP = gatedLoop('never', ['stop-line-1'], ['stop-line-never'], true);

test('a Bash card streams output, copies, fails visibly, handles large output and settles when stopped', async ({ app, model }) => {
  const window = app.window;
  const transcript = window.getByRole('list').first();
  const clipboardWrites = await captureClipboardWrites(app);

  await test.step('a running command shows an expanded running card with its command', async () => {
    model.script(bash(STREAM, { description: 'Stream four lines' }), say('Streamed four lines.'));
    await app.startTurn('Stream some lines');
    const card = toolCard(transcript, STREAM);
    await expect(card.getByRole('status', { name: 'running' })).toBeVisible();
    const expand = card.getByRole('button', { name: 'Expand details' });
    if (await expand.isVisible()) await expand.click();
    await expect(card.getByRole('button', { name: 'Collapse details' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'To background' })).toBeVisible();
    await expect(card.getByText('Bash', { exact: true })).toBeVisible();
    await expect(cardOutput(card).getByText('stream-line-3', { exact: true })).toHaveCount(0);
    await expect(card.getByRole('status', { name: 'running' })).toBeVisible();
    await app.snapshot('running-card');
  });

  await test.step('the command completes and the model gets the full output', async () => {
    const card = toolCard(transcript, STREAM);
    const next = model.requests().length;
    await writeFile(join(app.workspace, gateFile('stream')), '');
    await expect(cardOutput(card).getByText('stream-line-4', { exact: true })).toBeVisible();
    await expect(card.getByRole('status')).toHaveCount(0);
    await expect(transcript.getByText('Streamed four lines.', { exact: true })).toBeVisible();
    const request = await model.waitForRequest(next);
    const result = textOf(request.messages.at(-1)!.content);
    expect(request.messages.at(-1)!.role).toBe('tool');
    expect(result).toMatch(/stream-line-1\nstream-line-2\nstream-line-3\nstream-line-4/);
    expect(result).not.toContain('ERROR');
    await app.snapshot('completed-card');
  });

  await test.step('copy buttons put the command and the output on the clipboard', async () => {
    const card = toolCard(transcript, STREAM);
    const copies = card.getByRole('button', { name: 'Copy' });
    await expect(copies).toHaveCount(2);
    await copies.nth(0).click();
    await expect.poll(clipboardWrites).toEqual([STREAM]);
    await copies.nth(1).click();
    await expect.poll(async () => (await clipboardWrites()).map(text => text.trimEnd())).toEqual([STREAM, 'stream-line-1\nstream-line-2\nstream-line-3\nstream-line-4']);
  });

  await test.step('a failing command shows an error with its exit code', async () => {
    model.script(bash(FAIL, { description: 'Fail on purpose' }), say('That command failed.'));
    const next = model.requests().length;
    await app.startTurn('Run the failing command');
    const card = toolCard(transcript, FAIL);
    await expect(transcript.getByText('That command failed.', { exact: true })).toBeVisible();
    await expect(card.getByRole('status', { name: 'error' })).toBeVisible();
    await card.getByRole('button', { name: 'Expand details' }).click();
    await expect(cardOutput(card).getByText('Command failed with exit code: 3.')).toBeVisible();
    await expect(cardOutput(card).getByText('boom-on-stderr')).toBeVisible();
    const result = textOf(model.request(next + 1).messages.at(-1)!.content);
    expect(result).toContain('Command failed with exit code: 3.');
    expect(result).toContain('boom-on-stderr');
    await app.snapshot('failed-card');
  });

  await test.step('a large output renders fully and the transcript stays responsive', async () => {
    model.script(bash(BIG, { description: 'Print many lines' }), say('Printed five thousand lines.'));
    const next = model.requests().length;
    await app.startTurn('Print a lot');
    const card = toolCard(transcript, BIG);
    await expect(transcript.getByText('Printed five thousand lines.', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Expand details' }).click();
    const output = cardOutput(card);
    await expect(output.getByText('big-1', { exact: true })).toBeVisible();
    const last = output.getByText('big-5000', { exact: true });
    await expect(last).toBeAttached();
    const [scrollHeight, clientHeight] = await output.evaluate(element => [element.scrollHeight, element.clientHeight]);
    expect(scrollHeight).toBeGreaterThan(clientHeight * 10);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    const result = textOf(model.request(next + 1).messages.at(-1)!.content);
    expect(result).toContain('big-5000');
    await app.snapshot('large-output');
    const composer = window.getByRole('combobox', { name: 'Message input' });
    await composer.click();
    await window.keyboard.type('still responsive');
    await expect(composer).toHaveText('still responsive');
    await window.keyboard.press('ControlOrMeta+a');
    await window.keyboard.press('Backspace');
  });

  await test.step('stopping the turn mid-command settles the card', async () => {
    model.script(bash(STOP, { description: 'Wait forever' }));
    await app.startTurn('Run something slow');
    const card = toolCard(transcript, STOP);
    await expect(card.getByRole('status', { name: 'running' })).toBeVisible();
    await expect.poll(() => existsSync(join(app.workspace, readyFile('never')))).toBe(true);
    await window.getByRole('button', { name: 'Interrupt', exact: true }).click();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect(transcript.getByRole('status').filter({ hasText: 'Manually stopped' })).toBeVisible();
    await expect(card.getByRole('status', { name: 'cancelled' })).toBeVisible();
    await card.getByRole('button', { name: 'Expand details' }).click();
    await expect(cardOutput(card).getByText('stop-line-1', { exact: true })).toBeVisible();
    await expect(cardOutput(card).getByText('Interrupted by user')).toBeVisible();
    await expect(cardOutput(card).getByText('stop-line-never')).toHaveCount(0);
    await app.snapshot('stopped-card');

    model.script(say('Ready again.'));
    const after = await app.startTurn('Are you still there?');
    await expect(transcript.getByText('Ready again.', { exact: true })).toBeVisible();
    const interrupted = after.messages.filter(message => message.role === 'tool').at(-1)!;
    expect(textOf(interrupted.content)).toContain('Interrupted by user');
    expect(messageProblems(after.messages)).toEqual([]);
  });

  await test.step('after a relaunch every card keeps its final state and output', async () => {
    const sessionUrl = window.url();
    await app.relaunch();
    const restored = app.window;
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText('Stream some lines')).toBeVisible({ timeout: 30_000 });
    if (restored.url() !== sessionUrl) await sidebar.getByText('Stream some lines').click();
    await expect.poll(() => restored.url()).toBe(sessionUrl);
    const list = restored.getByRole('list').first();
    await expect(list.getByText('Ready again.', { exact: true })).toBeVisible();
    await expect(toolCard(list, STREAM).getByRole('status')).toHaveCount(0);
    await expect(toolCard(list, FAIL).getByRole('status', { name: 'error' })).toBeVisible();
    await expect(toolCard(list, STOP).getByRole('status', { name: 'cancelled' })).toBeVisible();
    await expect(toolCard(list, BIG).getByRole('status')).toHaveCount(0);
    const failed = toolCard(list, FAIL);
    await failed.getByRole('button', { name: 'Expand details' }).click();
    await expect(cardOutput(failed).getByText('Command failed with exit code: 3.')).toBeVisible();
    const streamed = toolCard(list, STREAM);
    await streamed.getByRole('button', { name: 'Expand details' }).click();
    await expect(cardOutput(streamed).getByText('stream-line-4', { exact: true })).toBeVisible();
    await expect(restored.getByText('Opening session…')).toBeHidden();
    await app.snapshot('restored-cards');
  });
});

test('a running Bash card streams output lines before the command finishes', async ({ app, model }) => {
  const transcript = app.window.getByRole('list').first();
  model.script(bash(STREAM, { description: 'Stream four lines' }), say('Streamed four lines.'));
  await app.startTurn('Stream some lines');
  const card = toolCard(transcript, STREAM);
  try {
    await expect(card.getByRole('status', { name: 'running' })).toBeVisible();
    await card.getByRole('button', { name: 'Expand details' }).click();
    await expect(card.getByRole('button', { name: 'Collapse details' })).toBeVisible();
    await expect(cardOutput(card).getByText('stream-line-2', { exact: true })).toBeVisible();
    await expect(card.getByRole('status', { name: 'running' })).toBeVisible();
  } finally {
    await writeFile(join(app.workspace, gateFile('stream')), '');
  }
});
