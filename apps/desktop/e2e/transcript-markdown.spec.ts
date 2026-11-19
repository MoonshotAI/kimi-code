import { expect, test } from './fixtures/app';
import { captureClipboardWrites } from './fixtures/clipboard';
import { messageProblems, say } from './fixtures/model';
import { answerNativeDialog } from './fixtures/native-dialog';
import { codeBlock, recordOpenExternal, relaunchAndSettle, startAssetServer, waitForSettledReply } from './fixtures/transcript';

const PROMPT = 'Write the release notes as rich markdown';
const TS_CODE = 'export const answer: number = 42;\nexport function double(value: number): number {\n  return value * 2;\n}\n';
const PY_CODE = 'def greet(name):\n    return f"hi {name}"\n';
const LONG_CODE = Array.from({ length: 40 }, (_, index) => `echo "step ${index + 1} of the long script"`).join('\n') + '\n';
const LAST_LINE = 'Release notes end here.';

test('rich markdown replies render structure, copy exact code, open links and images, and survive a relaunch', async ({ app, model }) => {
  const assets = await startAssetServer();
  const docsUrl = assets.url('docs.html');
  const logoUrl = assets.url('logo.svg');
  const transcript = app.window.getByRole('list').first();
  const markdown = [
    '# Release notes\n\n',
    '## Build steps\n\n',
    '1. Build\n   - compile `src`\n   - bundle assets\n2. Ship\n\n',
    '| Package | Size |\n| --- | --- |\n| core | 12 KB |\n| ui | 30 KB |\n\n',
    `\`\`\`ts\n${TS_CODE}\`\`\`\n\n`,
    `\`\`\`python\n${PY_CODE}\`\`\`\n\n`,
    `\`\`\`bash\n${LONG_CODE}\`\`\`\n\n`,
    '> Ship small, ship often.\n\n',
    '- [x] Changelog written\n- [ ] Announcement sent\n\n',
    `Read [the release docs](${docsUrl}) and remember $E = mc^2$.\n\n`,
    `![release logo](${logoUrl})\n\n`,
    LAST_LINE,
  ];

  try {
    await test.step('a streamed markdown reply renders headings, nested lists, a table, a quote, a task list and math', async () => {
      model.script(say(markdown, { intervalMs: 20 }));
      const request = await app.startTurn(PROMPT);
      expect(request.userTextsSinceReply).toEqual([PROMPT]);
      await waitForSettledReply(app.window, LAST_LINE);

      await expect(transcript.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
      await expect(transcript.getByRole('heading', { name: 'Build steps', level: 2 })).toBeVisible();
      const buildItem = transcript.getByRole('listitem').filter({ hasText: 'Build' }).filter({ has: app.window.getByRole('list') }).last();
      await expect(buildItem.getByRole('listitem')).toHaveText(['compile src', 'bundle assets']);
      await expect(buildItem.getByRole('code')).toHaveText('src');

      const table = transcript.getByRole('table');
      await expect(table.getByRole('columnheader')).toHaveText([/Package/, 'Size']);
      await expect(table.getByRole('row')).toHaveCount(3);
      await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText(['core', '12 KB']);
      await expect(table.getByRole('row').nth(2).getByRole('cell')).toHaveText(['ui', '30 KB']);
      await expect(transcript.getByRole('button', { name: 'Copy table' })).toBeVisible();

      await expect(transcript.getByRole('blockquote')).toHaveText('Ship small, ship often.');
      await expect(transcript.getByRole('listitem').filter({ hasText: 'Changelog written' }).last().getByRole('img', { name: 'checked', exact: true })).toBeVisible();
      await expect(transcript.getByRole('listitem').filter({ hasText: 'Announcement sent' }).last().getByRole('img', { name: 'unchecked', exact: true })).toBeVisible();
      const math = transcript.locator('[data-markstream-math="inline"]');
      await expect(math).toHaveCount(1);
      await expect(math).toContainText('mc');
      await expect(transcript.getByText('$E = mc^2$')).toHaveCount(0);
      await app.snapshot('rich-markdown');
    });

    await test.step('fenced code blocks show their language and copy exactly the fenced code', async () => {
      const ts = codeBlock(transcript, 'TypeScript');
      const python = codeBlock(transcript, 'Python');
      const shell = codeBlock(transcript, 'Shell');
      await expect(ts.getByRole('code')).toContainText('export const answer: number = 42;');
      await expect(python.getByRole('code')).toContainText('def greet(name):');
      await expect(shell.getByRole('code')).toContainText('step 40 of the long script');

      const clipboard = await captureClipboardWrites(app);
      await ts.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect.poll(clipboard).toEqual([TS_CODE]);
      await python.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect.poll(clipboard).toEqual([TS_CODE, PY_CODE]);
      await shell.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect.poll(clipboard).toEqual([TS_CODE, PY_CODE, LONG_CODE]);

      await ts.getByRole('button', { name: 'Enable word wrap' }).click();
      await expect(ts.getByRole('button', { name: 'Disable word wrap' })).toBeVisible();
      await expect(python.getByRole('button', { name: 'Enable word wrap' })).toBeVisible();
      await ts.getByRole('button', { name: 'Disable word wrap' }).click();
      await expect(ts.getByRole('button', { name: 'Enable word wrap' })).toBeVisible();
      await ts.scrollIntoViewIfNeeded();
      await app.snapshot('code-blocks');
    });

    await test.step('a markdown image loads from its local URL', async () => {
      const image = transcript.getByRole('img', { name: 'release logo' });
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(120);
      expect(assets.hits('logo.svg')).toBeGreaterThanOrEqual(1);
      await expect(transcript.getByText('Image failed to load')).toHaveCount(0);
      await app.snapshot('image');
    });

    await test.step('the link tooltip opens the link in the built-in browser panel', async () => {
      const link = transcript.getByRole('link', { name: `Link: ${docsUrl}` });
      await expect(link).toHaveText('the release docs');
      await link.hover();
      const toRightPanel = app.window.getByRole('button', { name: 'Right panel', exact: true });
      await expect(toRightPanel).toBeVisible();
      await expect(app.window.getByRole('button', { name: 'External', exact: true })).toBeVisible();
      await toRightPanel.click();
      const docs = await app.page(url => url === docsUrl, 'release docs in the built-in browser');
      await expect(docs.getByRole('heading', { name: 'Transcript docs fixture' })).toBeVisible();
      expect(assets.hits('docs.html')).toBe(1);
      await app.snapshot('link-in-right-panel');
    });

    await test.step('a plain click on the link hands it to the system browser through the guarded shell', async () => {
      const opened = await recordOpenExternal(app);
      await answerNativeDialog(app, 'openExternal', undefined);
      await transcript.getByRole('link', { name: `Link: ${docsUrl}` }).click();
      await expect.poll(opened).toEqual([docsUrl]);
      expect(assets.hits('docs.html')).toBe(1);
    });

    await test.step('the model saw one clean user prompt for the turn', async () => {
      expect(model.requests()).toHaveLength(1);
      expect(messageProblems(model.request(0).messages)).toEqual([]);
      expect(model.request(0).texts('user').filter(text => text === PROMPT)).toHaveLength(1);
    });

    await test.step('after a relaunch the restored reply renders the same structure and still copies exact code', async () => {
      await relaunchAndSettle(app, PROMPT);
      const restored = app.window.getByRole('list').first();
      await expect(restored.getByText(LAST_LINE, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(restored.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
      await expect(restored.getByRole('table').getByRole('row').nth(2).getByRole('cell')).toHaveText(['ui', '30 KB']);
      await expect(restored.getByRole('listitem').filter({ hasText: 'Changelog written' }).last().getByRole('img', { name: 'checked', exact: true })).toBeVisible();
      await expect(restored.locator('[data-markstream-math="inline"]')).toContainText('mc');
      const ts = codeBlock(restored, 'TypeScript');
      await expect(ts.getByRole('code')).toContainText('export const answer: number = 42;');
      const clipboard = await captureClipboardWrites(app);
      await ts.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect.poll(clipboard).toEqual([TS_CODE]);
      const image = restored.getByRole('img', { name: 'release logo' });
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(120);
      expect(model.requests()).toHaveLength(1);
      await app.snapshot('restored-markdown');
    });
  } finally {
    await assets.close();
  }
});

test('display math keeps CJK subscript glyphs inside the scroll container', async ({ app, model }) => {
  const transcript = app.window.getByRole('list').first();
  model.script(say(String.raw`\[
TPS=\frac{AL}{T_\text{完整投机步骤}}
\]`));
  await app.startTurn('Render a formula with a Chinese subscript');

  const display = transcript.locator('.katex-display');
  const cjk = display.locator('.cjk_fallback');
  await expect(cjk).toHaveText('完整投机步骤');
  await expect(display).toHaveCSS('overflow-x', 'auto');
  await expect(display).toHaveCSS('overflow-y', 'hidden');
  const bounds = await cjk.evaluate(element => {
    const container = element.closest('.katex-display')!.getBoundingClientRect();
    const glyph = element.getBoundingClientRect();
    return { containerBottom: container.bottom, glyphBottom: glyph.bottom };
  });
  expect(bounds.glyphBottom).toBeLessThanOrEqual(bounds.containerBottom + 1);
  await app.snapshot('display-math-cjk-subscript');
});
