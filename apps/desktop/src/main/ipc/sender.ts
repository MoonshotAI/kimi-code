import type { WebContents } from 'electron';
import { getMainWindow } from '../window/main-window';

export function isMainRendererSender(sender: WebContents): boolean {
  const win = getMainWindow();
  return win !== null && !win.isDestroyed() && sender === win.webContents;
}
