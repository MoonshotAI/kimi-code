import { basename } from 'node:path';

import { expect, type DesktopApp } from './app';
import { answerNativeDialog } from './native-dialog';

export async function createProject(app: DesktopApp, path = app.workspace): Promise<void> {
  await answerNativeDialog(app, 'showOpenDialog', { canceled: false, filePaths: [path] });
  await app.window.getByRole('button', { name: /^new project$/i }).first().click();
  const dialog = app.window.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('button', { name: 'Click to add folders you can read and write' }).click();
  await expect(dialog.getByRole('textbox')).toHaveValue(basename(path));
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
}
