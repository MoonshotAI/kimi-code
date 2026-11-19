import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { createProject } from './fixtures/project';
import { expectOrder, relaunchAndSettle, sendAndFinish, sessionRow, sidebarOf } from './fixtures/sessions';

const FIRST = 'Sketch the public API';
const SECOND = 'Wire the storage layer';
const THIRD = 'Add the pinned workspace tests';

async function html5Drag(source: Locator, target: Locator, position: 'before' | 'after'): Promise<void> {
  const srcHandle = await source.elementHandle();
  const dstHandle = await target.elementHandle();
  if (!srcHandle || !dstHandle) throw new Error('Drag source or target is not mounted');
  await source.page().evaluate(
    ([src, dst, pos]) => {
      const dataTransfer = new DataTransfer();
      const srcBox = src.getBoundingClientRect();
      const dstBox = dst.getBoundingClientRect();
      const clientX = dstBox.left + dstBox.width / 2;
      const clientY = pos === 'before' ? dstBox.top + 4 : dstBox.bottom - 4;
      src.dispatchEvent(
        new DragEvent('dragstart', {
          dataTransfer,
          bubbles: true,
          cancelable: true,
          clientX: srcBox.left + srcBox.width / 2,
          clientY: srcBox.top + srcBox.height / 2,
        }),
      );
      dst.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      );
      dst.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      );
      src.dispatchEvent(
        new DragEvent('dragend', {
          dataTransfer,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      );
    },
    [srcHandle, dstHandle, position] as const,
  );
}

test('pinned workspaces share the pinned section, support manual reordering, survive a relaunch and return to their original group', async ({ app, model, scratch }) => {
  const project = join(scratch, 'second-project');
  await mkdir(project, { recursive: true });
  let sidebar = sidebarOf(app);
  const group = (name: string) => sidebar.locator('[data-ws-id]').filter({ has: app.window.getByText(name, { exact: true }) });
  const pinnedGroup = (name: string) => sidebar.locator('.pinned [data-ws-id]').filter({ has: app.window.getByText(name, { exact: true }) });
  const regularGroup = (name: string) => sidebar.locator('.sessions [data-ws-id]').filter({ has: app.window.getByText(name, { exact: true }) });

  await sendAndFinish(app, model, FIRST, 'First reply.');
  await createProject(app, project);
  await app.trustWorkspace();
  await group('second-project').getByText('second-project', { exact: true }).hover();
  await group('second-project').getByRole('button', { name: 'New session in this project' }).click();
  await sendAndFinish(app, model, SECOND, 'Second reply.');
  await expect(group('second-project').getByText(SECOND)).toBeVisible();
  await app.snapshot('before-pinning-workspace');

  await test.step('pin a session and then a workspace, appending new pins at the tail with compact single-line rows', async () => {
    await sessionRow(app, FIRST).hover();
    await sessionRow(app, FIRST).getByRole('button', { name: 'Pin', exact: true }).click();
    const pinnedFirstRow = sidebar.locator('.pinned [data-session-id]').filter({ hasText: FIRST });
    await expect(pinnedFirstRow).toBeVisible();
    await expect(pinnedFirstRow).toHaveClass(/compact-pinned/);
    await expect(pinnedFirstRow.locator('.sub')).toHaveCount(0);
    await expect(pinnedFirstRow.locator('.lead-icon')).toBeVisible();

    await group('second-project').getByRole('button', { name: 'Options' }).click({ force: true });
    await app.window.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect(pinnedGroup('second-project')).toBeVisible();
    await expect(pinnedGroup('second-project').getByText(SECOND)).toBeVisible();
    await expect(regularGroup('second-project')).toHaveCount(0);
    await expect(regularGroup('workspace')).toBeVisible();
    await expectOrder(sidebar.locator('.pinned'), [FIRST, 'second-project', SECOND]);
  });

  await test.step('manually reorder entries inside the pinned section', async () => {
    const wsHeader = pinnedGroup('second-project').locator('.gh');
    const firstPinEntry = sidebar.locator('.pinned .pin-row').filter({ hasText: FIRST });
    await html5Drag(wsHeader, firstPinEntry, 'before');
    await expectOrder(sidebar.locator('.pinned'), ['second-project', SECOND, FIRST]);
    await app.snapshot('pinned-workspace-and-session');
  });

  await test.step('switch pinned sessions to show project subtitles via the pinned options menu', async () => {
    await sidebar.locator('.pinned .pinned-label').hover();
    await sidebar.locator('.pinned').getByRole('button', { name: 'Pinned options', exact: true }).click();
    await app.window.getByRole('menuitem', { name: 'Show project', exact: true }).click();
    const pinnedFirstRow = sidebar.locator('.pinned [data-session-id]').filter({ hasText: FIRST });
    await expect(pinnedFirstRow.locator('.sub')).toHaveCount(1);
    await expect(pinnedFirstRow.locator('.sub-icon')).toHaveCount(0);
    await expect(pinnedFirstRow.locator('.sub-text')).toHaveText('workspace');
    await app.snapshot('pinned-workspace-and-session-with-project');
  });

  await test.step('collapse, expand and create a session from the pinned workspace', async () => {
    await pinnedGroup('second-project').getByText('second-project', { exact: true }).click();
    await expect(pinnedGroup('second-project').locator('.group-sessions')).toHaveClass(/collapsed/);
    await pinnedGroup('second-project').getByText('second-project', { exact: true }).click();
    await expect(pinnedGroup('second-project').locator('.group-sessions')).not.toHaveClass(/collapsed/);

    await pinnedGroup('second-project').getByText('second-project', { exact: true }).hover();
    await pinnedGroup('second-project').getByRole('button', { name: 'New session in this project' }).click();
    await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
    await sendAndFinish(app, model, THIRD, 'Third reply.');
    await expect(pinnedGroup('second-project').getByText(THIRD)).toBeVisible();
  });

  await test.step('restore the pinned workspace, display mode and manual order after a relaunch', async () => {
    await relaunchAndSettle(app);
    sidebar = sidebarOf(app);
    await expect(pinnedGroup('second-project')).toBeVisible({ timeout: 30_000 });
    await expect(pinnedGroup('second-project').getByText(SECOND)).toBeVisible();
    await expect(pinnedGroup('second-project').getByText(THIRD)).toBeVisible();
    await expect(regularGroup('second-project')).toHaveCount(0);
    await expectOrder(sidebar.locator('.pinned'), ['second-project', THIRD, SECOND, FIRST]);
    const pinnedFirstRow = sidebar.locator('.pinned [data-session-id]').filter({ hasText: FIRST });
    await expect(pinnedFirstRow.locator('.sub-text')).toHaveText('workspace');
    const stored = await app.window.evaluate(() => JSON.parse(globalThis.localStorage.getItem('kimi-web.pinned-workspaces') ?? '[]'));
    expect(stored).toHaveLength(1);
  });

  await test.step('switch back to compact pinned rows via right-clicking the pinned header', async () => {
    await sidebar.locator('.pinned .pinned-label').click({ button: 'right' });
    await app.window.getByRole('menuitem', { name: 'Compact', exact: true }).click();
    const pinnedFirstRow = sidebar.locator('.pinned [data-session-id]').filter({ hasText: FIRST });
    await expect(pinnedFirstRow.locator('.sub')).toHaveCount(0);
  });

  await test.step('unpin the workspace back into the regular groups', async () => {
    await pinnedGroup('second-project').getByRole('button', { name: 'Options' }).click({ force: true });
    await app.window.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
    await expect(pinnedGroup('second-project')).toHaveCount(0);
    await expect(regularGroup('second-project')).toBeVisible();
    await expect(regularGroup('second-project').getByText(SECOND)).toBeVisible();
    await expect(regularGroup('second-project').getByText(THIRD)).toBeVisible();
    await expect(sidebar.locator('.pinned').getByText(FIRST, { exact: true })).toBeVisible();
    const stored = await app.window.evaluate(() => JSON.parse(globalThis.localStorage.getItem('kimi-web.pinned-workspaces') ?? '[]'));
    expect(stored).toEqual([]);
    await app.snapshot('after-unpinning-workspace');
  });
});
