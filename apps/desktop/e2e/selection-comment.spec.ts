import { expect, test, type DesktopApp } from './fixtures/app';
import { createProject } from './fixtures/project';
import { held, say, type StubModel } from './fixtures/model';

const INITIAL_REPLY = `${Array.from({ length: 16 }, (_, index) => `Initial line ${index + 1}`).join('\n\n')}\n\nSelect this sentence.`;
const STREAMED_REPLY = Array.from({ length: 16 }, (_, index) => `Streamed line ${index + 1}`).join('\n\n');

test.use({ seedWorkspace: false });

async function startStreamingTurn(app: DesktopApp, model: StubModel): Promise<void> {
  await createProject(app);
  await app.trustWorkspace();
  model.script(held('streaming', say([INITIAL_REPLY, STREAMED_REPLY]), 1));
  await app.startTurn('Stream a long reply');
  const selected = app.window.getByRole('list').first().getByText('Select this sentence.', { exact: true });
  await expect(selected).toBeVisible();
  await selected.evaluate((element) => {
    const text = element.firstChild;
    if (text === null) throw new Error('The assistant text node is missing');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Select this sentence.'.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expect(app.window.locator('.sab')).toBeVisible();
}

async function releaseStream(app: DesktopApp, model: StubModel): Promise<void> {
  const scrollBefore = await app.window.locator('.panes').evaluate((element) => element.scrollTop);
  model.hold('streaming').release();
  await expect(app.window.getByRole('list').first().getByText('Streamed line 16', { exact: true })).toBeVisible();
  await expect.poll(() => app.window.locator('.panes').evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);
}

test('selection actions survive a streamed transcript update', async ({ app, model }) => {
  await startStreamingTurn(app, model);
  await app.snapshot('selection-menu-before-stream');

  await releaseStream(app, model);
  await expect(app.window.locator('.sab')).toBeVisible();
  await app.snapshot('selection-menu-after-stream');
});

test('a comment draft survives a streamed transcript update', async ({ app, model }) => {
  await startStreamingTurn(app, model);
  const bubble = app.window.locator('.sab');
  await bubble.getByRole('menuitem', { name: 'Comment', exact: true }).click();
  const comment = bubble.getByRole('textbox');
  await expect(comment).toBeFocused();
  await comment.fill('Keep this unsubmitted draft');
  await app.snapshot('comment-before-stream');

  await releaseStream(app, model);
  await expect(comment).toBeVisible();
  await expect(comment).toHaveValue('Keep this unsubmitted draft');
  await app.snapshot('comment-after-stream');
});
