import { describe, expect, it, vi } from 'vitest';

import { createQuitConfirmHandler, useQuitConfirm } from '../../src/renderer/composables/useQuitConfirm';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeHandler(overrides: Partial<Parameters<typeof createQuitConfirmHandler>[0]> = {}) {
  const confirm = vi.fn().mockResolvedValue(true);
  const cancelCurrent = vi.fn();
  const isBusy = vi.fn(() => false);
  const isOverlayOpen = vi.fn(() => false);
  const respond = vi.fn();
  const handler = createQuitConfirmHandler({
    confirm,
    cancelCurrent,
    isBusy,
    isOverlayOpen,
    respond,
    t: (key) => key,
    ...overrides,
  });
  return { handler, confirm, cancelCurrent, isBusy, isOverlayOpen, respond };
}

describe('createQuitConfirmHandler', () => {
  it('confirms with the quit copy and responds quit with the request id', async () => {
    const { handler, confirm, respond } = makeHandler();
    await handler.prompt(7, ['busy']);
    expect(confirm).toHaveBeenCalledWith({
      title: 'app.quitConfirmTitle',
      message: 'app.quitConfirmMessage',
      confirmLabel: 'app.quitConfirmQuit',
      cancelLabel: 'app.quitConfirmCancel',
      variant: 'danger',
      initialFocus: 'cancel',
    });
    expect(respond).toHaveBeenCalledWith('quit', 7);
  });

  it('uses the remote control copy when that is the only reason', async () => {
    const { handler, confirm } = makeHandler();
    await handler.prompt(7, ['remote-control']);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'app.quitConfirmMessageRemoteControl' }),
    );
  });

  it('uses the combined copy when sessions are busy and remote control is on', async () => {
    const { handler, confirm } = makeHandler();
    await handler.prompt(7, ['busy', 'remote-control']);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'app.quitConfirmMessageBusyAndRemoteControl' }),
    );
  });

  it('falls back to the busy copy for empty or unknown reasons', async () => {
    const { handler, confirm } = makeHandler();
    await handler.prompt(7, []);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'app.quitConfirmMessage' }),
    );
  });

  it('responds cancel when the dialog is dismissed', async () => {
    const { handler, confirm, respond } = makeHandler({ confirm: vi.fn().mockResolvedValue(false) });
    await handler.prompt(3, ['busy']);
    expect(respond).toHaveBeenCalledWith('cancel', 3);
  });

  it('responds unavailable without prompting while another confirm action is running', async () => {
    const { handler, confirm, respond } = makeHandler({ isBusy: vi.fn(() => true) });
    await handler.prompt(9, ['busy']);
    expect(confirm).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('unavailable', 9);
  });

  it('responds unavailable without prompting while an interruptive overlay is open', async () => {
    const { handler, confirm, respond } = makeHandler({ isOverlayOpen: vi.fn(() => true) });
    await handler.prompt(10, ['busy']);
    expect(confirm).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('unavailable', 10);
  });

  it('prompts normally once the interruptive overlay is gone', async () => {
    let overlayOpen = true;
    const { handler, confirm, respond } = makeHandler({ isOverlayOpen: vi.fn(() => overlayOpen) });
    await handler.prompt(11, ['busy']);
    expect(confirm).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('unavailable', 11);
    overlayOpen = false;
    await handler.prompt(12, ['busy']);
    expect(confirm).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('quit', 12);
  });

  it('ignores a second prompt while the dialog is open', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const { handler, respond } = makeHandler({ confirm });
    const first = handler.prompt(1, ['busy']);
    await flush();
    await handler.prompt(2, ['busy']);
    expect(confirm).toHaveBeenCalledOnce();
    release(true);
    await first;
    expect(respond).toHaveBeenCalledWith('quit', 1);
    expect(respond).not.toHaveBeenCalledWith(expect.anything(), 2);
  });

  it('cancel closes the stale dialog without responding', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const { handler, cancelCurrent, respond } = makeHandler({ confirm });
    const pending = handler.prompt(5, ['busy']);
    await flush();
    handler.cancel(5);
    expect(cancelCurrent).toHaveBeenCalledOnce();
    release(false);
    await pending;
    expect(respond).not.toHaveBeenCalled();
  });

  it('ignores cancel for a different request id', async () => {
    const { handler, cancelCurrent } = makeHandler();
    const pending = handler.prompt(5, ['busy']);
    await flush();
    handler.cancel(6);
    expect(cancelCurrent).not.toHaveBeenCalled();
    await pending;
  });

  it('accepts a new prompt after the previous one was cancelled', async () => {
    let release: (ok: boolean) => void = () => undefined;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const { handler, respond } = makeHandler({ confirm });
    const first = handler.prompt(5, ['busy']);
    await flush();
    handler.cancel(5);
    release(false);
    await first;
    const second = handler.prompt(6, ['busy']);
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    release(true);
    await second;
    expect(respond).toHaveBeenCalledWith('quit', 6);
  });
});

describe('useQuitConfirm', () => {
  it('returns a no-op cleanup without the desktop bridge', () => {
    const off = useQuitConfirm({
      confirm: vi.fn(),
      cancelCurrent: vi.fn(),
      isBusy: () => false,
      isOverlayOpen: () => false,
      t: (key) => key,
    });
    expect(() => off()).not.toThrow();
  });

  it('subscribes to prompt and cancel events and unsubscribes on cleanup', async () => {
    const promptListeners = new Set<(requestId: number, reasons: Array<'busy' | 'remote-control'>) => void>();
    const cancelListeners = new Set<(requestId: number) => void>();
    const respondQuitConfirm = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      kimiDesktop: {
        onQuitConfirm: (cb: (requestId: number) => void) => {
          promptListeners.add(cb);
          return () => promptListeners.delete(cb);
        },
        onQuitConfirmCancel: (cb: (requestId: number) => void) => {
          cancelListeners.add(cb);
          return () => cancelListeners.delete(cb);
        },
        respondQuitConfirm,
      },
    });
    try {
      const confirm = vi.fn().mockResolvedValue(true);
      const off = useQuitConfirm({
        confirm,
        cancelCurrent: vi.fn(),
        isBusy: () => false,
        isOverlayOpen: () => false,
        t: (key) => key,
      });
      expect(promptListeners.size).toBe(1);
      expect(cancelListeners.size).toBe(1);
      for (const cb of promptListeners) cb(11, ['busy']);
      await flush();
      expect(confirm).toHaveBeenCalledOnce();
      expect(respondQuitConfirm).toHaveBeenCalledWith('quit', 11);
      off();
      expect(promptListeners.size).toBe(0);
      expect(cancelListeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
