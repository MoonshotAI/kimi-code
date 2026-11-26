import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { dropTextFile, pasteImage } from './fixtures/composer';
import { messageProblems, say, textOf } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const NOTES = 'Release checklist:\n1. bump version\n2. tag\n';

test('a prompt with a file mention, a pasted image and a dropped file reaches the model with every reference', { tag: '@quarantine' }, async ({ app, model }) => {
  await mkdir(join(app.workspace, 'src'), { recursive: true });
  await mkdir(join(app.workspace, 'docs'), { recursive: true });
  await writeFile(join(app.workspace, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  await writeFile(join(app.workspace, 'src', 'beta.ts'), 'export const beta = 2;\n');
  await writeFile(join(app.workspace, 'docs', 'guide.md'), '# Guide\n');
  model.script(say('Workspace opened.'), say('Reviewed beta, the screenshot and the notes.'));
  const window = app.window;
  const input = window.getByRole('combobox', { name: 'Message input' });
  const transcript = window.getByRole('list').first();
  const rail = window.getByRole('list', { name: 'Media rail' });
  const mentionMenu = window.getByRole('listbox');
  let redBox: Buffer = Buffer.alloc(0);
  let blueBox: Buffer = Buffer.alloc(0);

  await test.step('a first turn opens a session in the workspace', async () => {
    await app.startTurn('Open the workspace');
    await expect(transcript.getByText('Workspace opened.', { exact: true })).toBeVisible();
  });

  await test.step('@ lists the workspace folders and typing filters files', async () => {
    await input.click();
    await window.keyboard.type('Review @');
    await expect(mentionMenu.getByText('Files', { exact: true })).toBeVisible();
    await expect(mentionMenu.getByRole('option')).toHaveText([/\bdocs\s*$/, /\bsrc\s*$/]);
    await app.snapshot('mention-menu');
    await window.keyboard.type('.ts');
    await expect(mentionMenu.getByRole('option', { name: /alpha\.ts/ })).toBeVisible();
    await expect(mentionMenu.getByRole('option', { name: /beta\.ts/ })).toBeVisible();
    await expect(mentionMenu.getByRole('option', { name: /guide\.md/ })).toBeHidden();
    await app.snapshot('mention-filtered');
  });

  await test.step('the keyboard picks a file and the chip renders inline', async () => {
    const beta = mentionMenu.getByRole('option', { name: /beta\.ts/ });
    for (let presses = 0; presses < 3 && await beta.getAttribute('aria-selected') !== 'true'; presses += 1) {
      await window.keyboard.press('ArrowDown');
    }
    await expect(beta).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Enter');
    await expect(mentionMenu).toBeHidden();
    await window.keyboard.type('carefully');
    await expect(input).toHaveText(/Review\s*beta\.ts\s*carefully/);
    await expect(input).not.toContainText('@');
    await app.snapshot('mention-chip');
  });

  await test.step('a pasted image appears in the media rail and can be removed', async () => {
    redBox = await pasteImage(window, 'red-box.png', ['#d33', '#36c']);
    await expect(rail.getByRole('button', { name: 'red-box.png', exact: true })).toBeVisible();
    await expect(rail.getByRole('listitem')).toHaveCount(1);
    await app.snapshot('image-in-rail');
    await rail.getByRole('listitem').first().hover();
    await rail.getByRole('button', { name: 'Remove Image 1' }).click();
    await expect(rail).toBeHidden();
    await expect(input).toHaveText(/Review\s*beta\.ts\s*carefully/);
  });

  await test.step('an image pasted again opens in the lightbox', async () => {
    blueBox = await pasteImage(window, 'blue-box.png', ['#36c', '#fc3']);
    const thumbnail = rail.getByRole('button', { name: 'blue-box.png', exact: true });
    await expect(thumbnail).toBeVisible();
    await thumbnail.focus();
    await window.keyboard.press('Enter');
    const lightbox = window.getByRole('dialog');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByText('blue-box.png', { exact: true })).toBeVisible();
    const image = lightbox.locator('img').first();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(120);
    await expect(lightbox.locator('.pswp__container')).toHaveCSS('overflow', 'visible');
    await app.snapshot('lightbox');
    await window.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
    await expect(rail.getByRole('listitem')).toHaveCount(1);
  });

  await test.step('a dropped text file becomes an inline attachment chip', async () => {
    await input.click();
    await window.keyboard.press('End');
    await dropTextFile(window, 'notes.txt', NOTES);
    await expect(input).toContainText('notes.txt');
    await app.snapshot('ready-to-send');
  });

  await test.step('the request carries the mention, the image and the uploaded file', async () => {
    const next = model.requests().length;
    await window.keyboard.press('Enter');
    const request = await model.waitForRequest(next);
    const prompt = request.messages.at(-1)!;
    expect(prompt.role).toBe('user');
    const parts = Array.isArray(prompt.content) ? prompt.content.map(part => part.text ?? '') : [textOf(prompt.content)];
    expect(parts[0]).toMatch(/^Review \[beta\.ts\]\(src\/beta\.ts\)\s+carefully/);
    expect(parts.join('\n')).not.toContain('alpha.ts');
    const imagePaths = [...parts.join('\n').matchAll(/<image path="([^"]+)">/g)].map(match => match[1]!);
    expect(imagePaths).toHaveLength(1);
    const sentImage = await readFile(imagePaths[0]!);
    expect(sentImage.equals(redBox)).toBe(false);
    expect(sentImage.equals(blueBox)).toBe(true);
    const notesPath = /Attached file "notes\.txt" \(text\/plain, \d+ bytes\): (.+?) — open it with the Read tool/.exec(parts.join('\n'))?.[1];
    expect(notesPath).toBeDefined();
    expect(await readFile(notesPath!, 'utf8')).toBe(NOTES);
    expect(messageProblems(request.messages)).toEqual([]);
    await expect(transcript.getByText('Reviewed beta, the screenshot and the notes.', { exact: true })).toBeVisible();
    await expect(transcript.getByRole('list', { name: 'Media rail' })).toBeVisible();
    await expect(rail).toHaveCount(1);
    await expect(input.getByRole('paragraph')).toHaveText(['']);
  });

  await test.step('the sent message keeps its chips and image after a relaunch', async () => {
    const sessionUrl = window.url();
    await app.relaunch();
    if (app.window.url() !== sessionUrl) await sidebarOf(app).getByText('Open the workspace').click();
    await expect.poll(() => app.window.url()).toBe(sessionUrl);
    const restored = app.window.getByRole('list').first();
    const sent = restored.getByRole('listitem').filter({ hasText: 'carefully' });
    await expect(sent.getByRole('button', { name: 'beta.ts' })).toBeVisible();
    const restoredNotes = sent.getByRole('button', { name: 'notes.txt' });
    await expect(restoredNotes).toHaveCount(1);
    await expect(restoredNotes).toBeVisible();
    await expect(sent.getByRole('list', { name: 'Media rail' }).getByRole('listitem')).toHaveCount(1);
    await expect(restored.getByText('Reviewed beta, the screenshot and the notes.', { exact: true })).toBeVisible();
    await app.snapshot('restored-message');
    await restoredNotes.click();
    const attachmentPreview = await app.page(url => url.startsWith('blob:'), 'dropped file preview');
    await expect(attachmentPreview.getByText('Release checklist:')).toBeVisible();
  });
});
