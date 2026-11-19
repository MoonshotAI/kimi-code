import { dialog } from 'electron';

import { launchChannel, setUncaughtErrorNotice } from '../diagnostics/log';
import { getMainWindow } from '../window/main-window';

export function installUncaughtErrorNotice(): void {
  if (launchChannel() === 'stable') return;
  setUncaughtErrorNotice(({ title, detail }) => {
    const win = getMainWindow();
    if (win === null || win.isDestroyed()) return;
    void dialog.showMessageBox(win, { type: 'error', message: title, detail }).catch(() => undefined);
  });
}
