import { globalShortcut } from 'electron';

import { bindingToAccelerator } from './menu';
import { showMainWindow } from './window';
import { log } from './log';
import { trackDesktopEvent } from './track';

// OS-level global shortcut that summons the app (brings the main window to the
// foreground even when the app is hidden or unfocused). The renderer owns the
// customizable binding (lib/keymap.ts `summonApp`, canonical format) and pushes
// it over IPC; the main process converts it to an Electron accelerator and
// registers it here.
//
// Registration is driven ENTIRELY by renderer pushes: the useShortcuts
// immediate watch replays the saved binding (default, custom, or null) on
// every boot, so nothing is grabbed before the user's setting is known — and
// with no renderer (connect error page) nothing registers at all.
//
// State model: `currentBinding` is the COMMITTED binding — the one that is (or
// was last) successfully live. A pushed chord only commits after the OS accepts
// it, so a refused rebind leaves the working shortcut (and the state a
// suspend/resume cycle re-registers) untouched. `deferredBinding` holds a push
// that arrived while registrations were suspended for shortcut recording; it is
// tried on resume, falling back to the committed binding when the OS refuses.

let currentBinding: string | null = null;
let registeredAccelerator: string | null = null;
let suspended = false;
let deferredBinding: string | null | undefined = undefined;

function deactivate(): void {
  if (registeredAccelerator !== null) {
    globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = null;
  }
}

/** Make `binding` the live global shortcut; false when Electron can't express
 *  it or the OS refuses it (taken by the system or another app) — in both
 *  cases any previously live accelerator stays registered. */
function activate(binding: string): boolean {
  const accelerator = bindingToAccelerator(binding);
  if (accelerator === undefined) {
    log.warn(`[kimi-desktop] global shortcut binding ${binding} cannot be expressed as an accelerator`);
    trackDesktopEvent('global_shortcut_register_failed', { reason: 'invalid' });
    return false;
  }
  if (accelerator === registeredAccelerator) {
    return true;
  }
  // Register the new chord BEFORE dropping the old one: a refusal must not
  // take the working shortcut down with it.
  const ok = globalShortcut.register(accelerator, () => {
    trackDesktopEvent('global_shortcut_invoked');
    showMainWindow();
  });
  if (!ok) {
    log.warn(`[kimi-desktop] global shortcut ${accelerator} not registered (already taken)`);
    trackDesktopEvent('global_shortcut_register_failed', { reason: 'conflicted' });
    return false;
  }
  deactivate();
  registeredAccelerator = accelerator;
  return true;
}

/** Replace the summon-app binding (canonical renderer format; null = off).
 *  Commits only on success — a refused chord keeps the previous working
 *  shortcut live instead of leaving the app with none. Returns whether the
 *  requested state went live (true when disabled, or when the push is
 *  deferred to the next resume while suspended — the resume then reports the
 *  outcome), so the renderer can flag bindings that will never fire. */
export function setGlobalShortcut(binding: string | null): boolean {
  if (suspended) {
    deferredBinding = binding;
    return true;
  }
  if (binding === null) {
    currentBinding = null;
    deactivate();
    return true;
  }
  if (activate(binding)) {
    currentBinding = binding;
    return true;
  }
  return false;
}

/** Suspend (true) or resume (false) the global shortcut while the settings
 *  panel records a shortcut — the live OS-level combo would otherwise be
 *  consumed by the system and never reach the recorder. Resume tries the
 *  deferred push when one arrived mid-recording, otherwise the committed
 *  binding, and reports whether the requested binding went live: false means
 *  the OS refused it (the committed binding was restored instead, so the
 *  panel can roll its override back). */
export function setGlobalShortcutSuspended(nextSuspended: boolean): boolean {
  if (suspended === nextSuspended) {
    return true;
  }
  suspended = nextSuspended;
  if (suspended) {
    deactivate();
    return true;
  }
  const binding = deferredBinding !== undefined ? deferredBinding : currentBinding;
  deferredBinding = undefined;
  if (binding === null) {
    currentBinding = null;
    return true;
  }
  if (activate(binding)) {
    currentBinding = binding;
    return true;
  }
  // The requested chord was refused — restore the committed binding (it was
  // unregistered by the suspend) so the working shortcut comes back.
  if (binding !== currentBinding && currentBinding !== null) {
    void activate(currentBinding);
  }
  return false;
}

export function unregisterGlobalShortcuts(): void {
  deferredBinding = undefined;
  globalShortcut.unregisterAll();
  registeredAccelerator = null;
}
