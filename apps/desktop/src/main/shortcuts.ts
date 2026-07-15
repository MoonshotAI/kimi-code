import { globalShortcut } from 'electron';

import { sendToRenderer } from './window';
import { IPC } from './ipc-channels';

// Best-effort global shortcut registration (Task 4.4 channel smoke test). A
// registration that collides with an existing OS/app binding returns false and
// is skipped with a warning rather than throwing. Task 4.5 finalizes the set.
const GLOBAL_SHORTCUTS = ['CommandOrControl+Alt+K'];

export function registerGlobalShortcuts(): void {
  for (const accel of GLOBAL_SHORTCUTS) {
    const ok = globalShortcut.register(accel, () => sendToRenderer(IPC.shortcut, accel));
    if (!ok) {
      process.stderr.write(`[kimi-desktop] global shortcut ${accel} not registered (already taken)\n`);
    }
  }
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
}
