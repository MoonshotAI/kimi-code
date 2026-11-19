import type { WebContents } from 'electron';

type Consumer = 'automation' | 'device' | 'focus' | 'dialogs' | 'user-agent' | symbol;
interface Connection {
  owned: boolean;
  consumers: Set<Consumer>;
  mouseTouch: boolean;
  inputActive: boolean;
  focusEmulated: boolean;
  generation: number;
  focusRevision: number;
  expectedDetach: boolean;
  detachListeners: Set<() => void>;
}

const connections = new WeakMap<WebContents, Connection>();
const mouseTouchSuspensions = new WeakMap<WebContents, number>();

export function isBrowserInputActive(contents: WebContents): boolean {
  return connections.get(contents)?.inputActive === true;
}

function browserConnection(contents: WebContents): Connection {
  let connection = connections.get(contents);
  if (connection === undefined) {
    connection = {
      owned: false, consumers: new Set(), mouseTouch: false, inputActive: false, focusEmulated: false,
      generation: 0, focusRevision: 0, expectedDetach: false, detachListeners: new Set(),
    };
    connections.set(contents, connection);
    const current = connection;
    contents.debugger.on('detach', () => {
      const expected = current.expectedDetach;
      current.expectedDetach = false;
      current.owned = false;
      current.mouseTouch = false;
      current.focusEmulated = false;
      current.inputActive = false;
      current.consumers.delete('device');
      current.consumers.delete('focus');
      current.consumers.delete('user-agent');
      if (expected) return;
      current.generation += 1;
      for (const listener of current.detachListeners) listener();
    });
  }
  return connection;
}

export function observeBrowserDebuggerDetach(contents: WebContents, listener: () => void): void {
  browserConnection(contents).detachListeners.add(listener);
}

export function browserDebuggerHasConsumer(contents: WebContents, consumer: Consumer): boolean {
  return connections.get(contents)?.consumers.has(consumer) === true;
}

export function browserDebuggerGeneration(contents: WebContents): number {
  return browserConnection(contents).generation;
}

export function ensureBrowserDebugger(contents: WebContents, consumer: Consumer): WebContents['debugger'] {
  const connection = browserConnection(contents);
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach('1.3');
    connection.owned = true;
  }
  connection.consumers.add(consumer);
  return contents.debugger;
}

export async function withBrowserDebugger<T>(contents: WebContents, work: (connection: WebContents['debugger']) => Promise<T>): Promise<T> {
  const lease = Symbol('automation');
  const connection = ensureBrowserDebugger(contents, lease);
  try { return await work(connection); }
  finally { releaseBrowserDebugger(contents, lease); }
}

export function setBrowserMouseTouchEmulation(contents: WebContents, enabled: boolean): Promise<unknown> {
  const connection = connections.get(contents);
  if (connection === undefined) throw new Error('Browser debugger is not attached');
  connection.mouseTouch = enabled;
  return contents.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
    enabled: enabled && !connection.inputActive && !mouseTouchSuspensions.has(contents),
    ...(enabled ? { configuration: 'mobile' } : {}),
  });
}

async function refreshBrowserMouseTouch(contents: WebContents): Promise<void> {
  const connection = connections.get(contents);
  if (connection === undefined || !connection.mouseTouch || contents.isDestroyed() || !contents.debugger.isAttached()) return;
  await setBrowserMouseTouchEmulation(contents, true).catch(() => {});
}

export async function suspendBrowserMouseTouch(contents: WebContents): Promise<() => Promise<void>> {
  mouseTouchSuspensions.set(contents, (mouseTouchSuspensions.get(contents) ?? 0) + 1);
  await refreshBrowserMouseTouch(contents);
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    const remaining = (mouseTouchSuspensions.get(contents) ?? 1) - 1;
    if (remaining > 0) {
      mouseTouchSuspensions.set(contents, remaining);
      return;
    }
    mouseTouchSuspensions.delete(contents);
    await refreshBrowserMouseTouch(contents);
  };
}

export async function setBrowserInputActive(contents: WebContents, active: boolean): Promise<void> {
  const connection = connections.get(contents);
  if (connection === undefined) throw new Error('Browser debugger is not attached');
  connection.inputActive = active;
  if (active && connection.mouseTouch) await setBrowserMouseTouchEmulation(contents, true);
  try {
    await applyBrowserFocusEmulation(contents, connection);
  } finally {
    if (!active && connection.mouseTouch) await setBrowserMouseTouchEmulation(contents, true);
  }
}

function applyBrowserFocusEmulation(contents: WebContents, connection: Connection): Promise<unknown> {
  return contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
    enabled: connection.focusEmulated || connection.inputActive,
  });
}

export function releaseBrowserDebugger(contents: WebContents, consumer: Consumer): void {
  const connection = connections.get(contents);
  if (connection === undefined) return;
  connection.consumers.delete(consumer);
  if (connection.consumers.size > 0 || !connection.owned) return;
  connection.owned = false;
  if (!contents.isDestroyed() && contents.debugger.isAttached()) {
    connection.expectedDetach = true;
    contents.debugger.detach();
  }
}

export function browserFocusEmulationEnabled(contents: WebContents): boolean {
  return connections.get(contents)?.focusEmulated ?? false;
}

export async function setBrowserFocusEmulation(contents: WebContents, enabled: boolean): Promise<void> {
  ensureBrowserDebugger(contents, 'focus');
  const connection = connections.get(contents)!;
  const revision = ++connection.focusRevision;
  const previous = connection.focusEmulated;
  const generation = connection.generation;
  connection.focusEmulated = enabled;
  try {
    await applyBrowserFocusEmulation(contents, connection);
    if (connection.generation !== generation) throw new Error('Browser debugger detached while setting focus emulation.');
  } catch (error) {
    if (connection.generation === generation && connection.focusRevision === revision) {
      connection.focusEmulated = previous;
      if (!previous) releaseBrowserDebugger(contents, 'focus');
    }
    throw error;
  }
  if (!enabled && connection.focusRevision === revision) releaseBrowserDebugger(contents, 'focus');
}
