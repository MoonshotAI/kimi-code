import { app, globalShortcut } from 'electron';

import { bindingToAccelerator } from './menu';
import { getMainWindow, isRendererReady, sendToRenderer, showMainWindow } from '../window/main-window';
import { log } from '../diagnostics/log';
import { isScreenshotShortcutEnabled } from '../release/release-channel';
import { trackDesktopEvent } from '../diagnostics/track';
import { noteHotkeyTrigger, captureScreenshot } from '../screenshot/controller';
import { IPC } from '../ipc/ipc-channels';
import type { GlobalShortcutResult } from '../../shared/global-shortcut';

export type { GlobalShortcutFailureReason, GlobalShortcutResult } from '../../shared/global-shortcut';

export type GlobalShortcutAction = 'summonApp' | 'captureScreenshot';

interface Registration {
  binding: string | null;
  accelerator: string | null;
}

const registrations = new Map<GlobalShortcutAction, Registration>([
  ['summonApp', { binding: null, accelerator: null }],
  ['captureScreenshot', { binding: null, accelerator: null }],
]);
const deferredBindings = new Map<GlobalShortcutAction, string | null>();
let recordingSuspended = false;
let terminalSuspended = false;

function isSuspended(action: GlobalShortcutAction): boolean {
  return recordingSuspended || (terminalSuspended && action === 'summonApp');
}

function invokeAction(action: GlobalShortcutAction): void {
  trackDesktopEvent('global_shortcut_invoked', { action });
  if (action === 'summonApp') {
    showMainWindow();
    return;
  }
  if (!isRendererReady()) return;
  noteHotkeyTrigger(getMainWindow()?.isVisible() ?? false);
  sendToRenderer(IPC.screenshotHotkey, null);
  void captureScreenshot().then((result) => {
    sendToRenderer(IPC.screenshotHotkeyResult, result);
  });
}

function deactivateAll(): void {
  for (const [action, registration] of registrations) {
    if (!isSuspended(action)) continue;
    if (registration.accelerator !== null) {
      globalShortcut.unregister(registration.accelerator);
      registration.accelerator = null;
    }
  }
}

function activate(action: GlobalShortcutAction, binding: string): GlobalShortcutResult {
  if (action === 'captureScreenshot' && !isScreenshotShortcutEnabled(app.getVersion())) {
    log.warn(`[kimi-desktop] screenshot global shortcut is disabled on this build (${app.getVersion()})`);
    return { ok: false, reason: 'channel-disabled' };
  }
  const accelerator = bindingToAccelerator(binding);
  if (accelerator === undefined) {
    log.warn(`[kimi-desktop] global shortcut binding ${binding} cannot be expressed as an accelerator`);
    trackDesktopEvent('global_shortcut_register_failed', { action, reason: 'invalid' });
    return { ok: false, reason: 'invalid' };
  }
  const registration = registrations.get(action) as Registration;
  if (accelerator === registration.accelerator) {
    return { ok: true };
  }
  const ok = globalShortcut.register(accelerator, () => invokeAction(action));
  if (!ok) {
    log.warn(`[kimi-desktop] global shortcut ${accelerator} not registered (already taken)`);
    trackDesktopEvent('global_shortcut_register_failed', { action, reason: 'conflicted' });
    return { ok: false, reason: 'conflicted' };
  }
  if (registration.accelerator !== null) {
    globalShortcut.unregister(registration.accelerator);
  }
  registration.accelerator = accelerator;
  return { ok: true };
}

export function setGlobalShortcutForAction(action: GlobalShortcutAction, binding: string | null): GlobalShortcutResult {
  if (isSuspended(action)) {
    deferredBindings.set(action, binding);
    return { ok: true };
  }
  const registration = registrations.get(action) as Registration;
  if (binding === null) {
    registration.binding = null;
    if (registration.accelerator !== null) {
      globalShortcut.unregister(registration.accelerator);
      registration.accelerator = null;
    }
    return { ok: true };
  }
  const result = activate(action, binding);
  if (result.ok) {
    registration.binding = binding;
  }
  return result;
}

export function setGlobalShortcut(binding: string | null): GlobalShortcutResult {
  return setGlobalShortcutForAction('summonApp', binding);
}

function resumeIfUnsuspended(): boolean {
  let allOk = true;
  for (const [action, registration] of registrations) {
    if (isSuspended(action)) continue;
    if (!deferredBindings.has(action)) {
      if (registration.binding !== null && !activate(action, registration.binding).ok) allOk = false;
      continue;
    }
    const deferred = deferredBindings.get(action) ?? null;
    deferredBindings.delete(action);
    if (deferred === null) {
      registration.binding = null;
      continue;
    }
    if (activate(action, deferred).ok) {
      registration.binding = deferred;
      continue;
    }
    allOk = false;
    if (registration.binding !== null) void activate(action, registration.binding);
  }
  return allOk;
}

export function setGlobalShortcutSuspended(nextSuspended: boolean): boolean {
  if (recordingSuspended === nextSuspended) {
    return true;
  }
  recordingSuspended = nextSuspended;
  if (recordingSuspended) {
    deactivateAll();
    return true;
  }
  return resumeIfUnsuspended();
}

export function setGlobalShortcutTerminalFocus(focused: boolean): void {
  if (terminalSuspended === focused) return;
  terminalSuspended = focused;
  if (terminalSuspended) {
    deactivateAll();
    return;
  }
  void resumeIfUnsuspended();
}

export function unregisterGlobalShortcuts(): void {
  deferredBindings.clear();
  globalShortcut.unregisterAll();
  for (const registration of registrations.values()) {
    registration.accelerator = null;
  }
}
