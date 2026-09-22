/**
 * Session tab shortcuts (experimental tabs).
 *
 * Installed as a TUI-level input listener rather than an editor binding so a
 * tab can be switched away from even while its approval panel or question
 * dialog holds focus — a background tab's prompt is exactly what the user
 * wants to leave pending while they look at another session.
 *
 * Bindings: Alt+1..9 select a tab; Ctrl+Tab / Ctrl+Shift+Tab cycle (Kitty /
 * modifyOtherKeys terminals only, legacy terminals cannot report Ctrl+Tab),
 * with Alt+N / Alt+P as the portable equivalents (Alt+] / Alt+[ would be a
 * bare CSI introducer on legacy terminals); Alt+T opens a new session in a
 * new tab; Alt+W closes the active tab. Ctrl+T / Ctrl+W stay with the
 * editor (todo panel / word delete).
 */

import { Key, matchesKey, type TUI } from '@moonshot-ai/pi-tui';

export type TabShortcut =
  | { readonly kind: 'next' }
  | { readonly kind: 'prev' }
  | { readonly kind: 'select'; readonly index: number }
  | { readonly kind: 'new' }
  | { readonly kind: 'close' };

export interface TabShortcutsHost {
  tabsEnabled(): boolean;
  switchTab(delta: 1 | -1): Promise<boolean>;
  activateTabAt(index: number): Promise<boolean>;
  createNewSession(mode: 'tab'): Promise<void>;
  closeActiveTab(): Promise<boolean>;
  showError(message: string): void;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function matchTabShortcut(data: string): TabShortcut | undefined {
  if (matchesKey(data, Key.ctrl('tab')) || matchesKey(data, Key.alt('n'))) return { kind: 'next' };
  if (matchesKey(data, Key.ctrlShift('tab')) || matchesKey(data, Key.alt('p'))) {
    return { kind: 'prev' };
  }
  if (matchesKey(data, Key.alt('t'))) return { kind: 'new' };
  if (matchesKey(data, Key.alt('w'))) return { kind: 'close' };
  for (const [index, digit] of DIGITS.entries()) {
    if (matchesKey(data, Key.alt(digit))) return { kind: 'select', index };
  }
  return undefined;
}

export function installTabShortcuts(ui: TUI, host: TabShortcutsHost): () => void {
  return ui.addInputListener((data) => {
    if (!host.tabsEnabled()) return undefined;
    const shortcut = matchTabShortcut(data);
    if (shortcut === undefined) return undefined;
    void runTabShortcut(host, shortcut).catch((error: unknown) => {
      host.showError(`Tab shortcut failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return { consume: true };
  });
}

async function runTabShortcut(host: TabShortcutsHost, shortcut: TabShortcut): Promise<void> {
  switch (shortcut.kind) {
    case 'next':
      await host.switchTab(1);
      return;
    case 'prev':
      await host.switchTab(-1);
      return;
    case 'select':
      await host.activateTabAt(shortcut.index);
      return;
    case 'new':
      await host.createNewSession('tab');
      return;
    case 'close':
      await host.closeActiveTab();
      return;
  }
}
