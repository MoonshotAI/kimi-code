import type { WebContents } from 'electron';
import { browserDebuggerHasConsumer, ensureBrowserDebugger, observeBrowserDebuggerDetach, releaseBrowserDebugger } from './browser-debugger';
import { activeBrowserUserAgent } from './browser-user-agent';
import { log } from '../diagnostics/log';

export interface BrowserUserAgentSync {
  readonly pending: number;
  enqueue(run: () => Promise<void>): Promise<void>;
  sync(): void;
  whenSettled(): Promise<void>;
  whenReadyToNavigate(): Promise<void>;
  dispose(): void;
}

export interface BrowserUserAgentSyncOptions {
  label: string;
  canOverride?: () => boolean;
  onDebuggerDetach?: () => void;
}

export function baseBrowserUserAgent(): string {
  return activeBrowserUserAgent().userAgent;
}

function userAgentOverrideActive(contents: WebContents): boolean {
  return contents.debugger.isAttached() && browserDebuggerHasConsumer(contents, 'user-agent');
}

export async function syncContentsUserAgent(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;
  contents.setUserAgent(baseBrowserUserAgent());
  const override = activeBrowserUserAgent();
  if (override?.userAgentMetadata !== undefined) {
    const held = browserDebuggerHasConsumer(contents, 'user-agent');
    const pageDebugger = ensureBrowserDebugger(contents, 'user-agent');
    try {
      await pageDebugger.sendCommand('Emulation.setUserAgentOverride', { ...override });
    } catch (error) {
      if (!held) releaseBrowserDebugger(contents, 'user-agent');
      throw error;
    }
    return;
  }
  if (!userAgentOverrideActive(contents)) return;
  await contents.debugger.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' });
  releaseBrowserDebugger(contents, 'user-agent');
}

export function createBrowserUserAgentSync(contents: WebContents, options: BrowserUserAgentSyncOptions): BrowserUserAgentSync {
  const canOverride = options.canOverride ?? (() => true);
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let retry = false;
  let disposed = false;
  let active = false;
  const queued: Array<{ started: Promise<void>; start: () => void }> = [];

  const enqueue = (run: () => Promise<void>): Promise<void> => {
    let start!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    queued.push({ started, start });
    const task = tail.catch(() => undefined).then(async () => {
      queued.shift()?.start();
      active = true;
      try {
        await run();
      } finally {
        active = false;
      }
    });
    tail = task;
    pending += 1;
    void task.catch(() => undefined).then(() => { pending -= 1; });
    return task;
  };

  const sync = (): void => {
    if (disposed || contents.isDestroyed()) return;
    retry = false;
    contents.setUserAgent(baseBrowserUserAgent());
    if (pending === 0 && canOverride() && activeBrowserUserAgent().userAgentMetadata === undefined && !userAgentOverrideActive(contents)) return;
    void enqueue(async () => {
      if (disposed || !canOverride()) return;
      await syncContentsUserAgent(contents);
    }).then(
      () => { retry = false; },
      (error: unknown) => {
        retry = true;
        log.warn(`[kimi-desktop] ${options.label} user agent update failed: ${String(error)}`);
      },
    );
  };

  const settle = async (): Promise<void> => {
    let current: Promise<void>;
    do {
      current = tail;
      await current.catch(() => undefined);
    } while (current !== tail);
  };

  const whenSettled = async (): Promise<void> => {
    await settle();
    if (!retry) return;
    sync();
    await settle();
  };

  const whenReadyToNavigate = async (): Promise<void> => {
    if (contents.isDestroyed() || contents.getOSProcessId() !== 0) return whenSettled();
    if (retry) sync();
    while (!active && queued.length > 0) await queued[0]!.started;
  };

  const dispose = (): void => { disposed = true; };

  observeBrowserDebuggerDetach(contents, () => {
    if (disposed || contents.isDestroyed()) return;
    options.onDebuggerDetach?.();
    if (!contents.isDevToolsOpened()) sync();
  });
  contents.on('devtools-closed', sync);
  contents.once('destroyed', dispose);

  return {
    get pending() { return retry ? pending + 1 : pending; },
    enqueue,
    sync,
    whenSettled,
    whenReadyToNavigate,
    dispose,
  };
}
