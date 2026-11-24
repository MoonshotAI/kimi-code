import { describe, expect, it, vi } from 'vitest';

import type { QuitBlockReason, QuitConfirmDetails } from '../../src/shared/quit-confirm';
import { createQuitConfirmHandler, useQuitConfirm } from '../../src/renderer/composables/useQuitConfirm';

const QUIT_DETAILS: QuitConfirmDetails = { purpose: 'quit', sessionTitles: [] };

function update(sessionTitles: string[]): QuitConfirmDetails {
  return { purpose: 'update', sessionTitles };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeHandler(overrides: Partial<Parameters<typeof createQuitConfirmHandler>[0]> = {}) {
  const confirm = vi.fn().mockResolvedValue(true);
  const confirmWithCheckbox = vi.fn().mockResolvedValue({ confirmed: true, checked: true });
  const cancelCurrent = vi.fn();
  const isBusy = vi.fn(() => false);
  const isOverlayOpen = vi.fn(() => false);
  const respond = vi.fn();
  const handler = createQuitConfirmHandler({
    confirm,
    confirmWithCheckbox,
    cancelCurrent,
    isBusy,
    isOverlayOpen,
    respond,
    t: (key, params) => (params === undefined ? key : `${key}:${String(params['count'])}`),
    ...overrides,
  });
  return { handler, confirm, confirmWithCheckbox, cancelCurrent, isBusy, isOverlayOpen, respond };
}

describe('createQuitConfirmHandler', () => {
  it('confirms with the quit copy and responds quit with the request id', async () => {
    const { handler, confirm, confirmWithCheckbox, respond } = makeHandler();
    await handler.prompt(7, ['busy']);
    expect(confirm).toHaveBeenCalledWith({
      title: 'app.quitConfirmTitle',
      message: 'app.quitConfirmMessage',
      confirmLabel: 'app.quitConfirmQuit',
      cancelLabel: 'app.quitConfirmCancel',
      variant: 'danger',
      initialFocus: 'cancel',
    });
    expect(confirmWithCheckbox).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('quit', 7, false);
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
    const { handler, respond } = makeHandler({ confirm: vi.fn().mockResolvedValue(false) });
    await handler.prompt(3, ['busy']);
    expect(respond).toHaveBeenCalledWith('cancel', 3, false);
  });

  it('responds unavailable without prompting while another confirm action is running', async () => {
    const { handler, confirm, respond } = makeHandler({ isBusy: vi.fn(() => true) });
    await handler.prompt(9, ['busy']);
    expect(confirm).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('unavailable', 9, false);
  });

  it('responds unavailable without prompting while an interruptive overlay is open', async () => {
    const { handler, confirm, respond } = makeHandler({ isOverlayOpen: vi.fn(() => true) });
    await handler.prompt(10, ['busy']);
    expect(confirm).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('unavailable', 10, false);
  });

  it('prompts normally once the interruptive overlay is gone', async () => {
    let overlayOpen = true;
    const { handler, confirm, respond } = makeHandler({ isOverlayOpen: vi.fn(() => overlayOpen) });
    await handler.prompt(11, ['busy']);
    expect(confirm).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith('unavailable', 11, false);
    overlayOpen = false;
    await handler.prompt(12, ['busy']);
    expect(confirm).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('quit', 12, false);
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
    expect(respond).toHaveBeenCalledWith('quit', 1, false);
    expect(respond).not.toHaveBeenCalledWith(expect.anything(), 2, expect.anything());
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
    expect(respond).toHaveBeenCalledWith('quit', 6, false);
  });

  describe('update restart', () => {
    it('lists the running sessions and offers to continue them, checked by default', async () => {
      const { handler, confirm, confirmWithCheckbox, respond } = makeHandler();
      await handler.prompt(8, ['busy'], update(['Fix login bug', 'Write tests']));
      expect(confirm).not.toHaveBeenCalled();
      expect(confirmWithCheckbox).toHaveBeenCalledWith({
        title: 'app.updateRestartTitle',
        message: 'app.updateRestartMessageSessions\n• Fix login bug\n• Write tests',
        confirmLabel: 'app.updateRestartConfirm',
        cancelLabel: 'app.quitConfirmCancel',
        variant: 'primary',
        initialFocus: 'cancel',
        checkbox: { label: 'app.updateRestartContinueSessions', checked: true },
      });
      expect(respond).toHaveBeenCalledWith('quit', 8, true);
    });

    it('restarts without continuing when the option is cleared', async () => {
      const { handler, respond } = makeHandler({
        confirmWithCheckbox: vi.fn().mockResolvedValue({ confirmed: true, checked: false }),
      });
      await handler.prompt(8, ['busy'], update(['Fix login bug']));
      expect(respond).toHaveBeenCalledWith('quit', 8, false);
    });

    it('never continues sessions when the restart is cancelled', async () => {
      const { handler, respond } = makeHandler({
        confirmWithCheckbox: vi.fn().mockResolvedValue({ confirmed: false, checked: true }),
      });
      await handler.prompt(8, ['busy'], update(['Fix login bug']));
      expect(respond).toHaveBeenCalledWith('cancel', 8, false);
    });

    it('shows the first three titles and counts the rest', async () => {
      const { handler, confirmWithCheckbox } = makeHandler();
      await handler.prompt(8, ['busy', 'remote-control'], update(['A', 'B', 'C', 'D', 'E']));
      expect(confirmWithCheckbox).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'app.updateRestartMessageSessions\n• A\n• B\n• C\napp.updateRestartMoreSessions:2\n\napp.updateRestartMessageRemoteControl',
        }),
      );
    });

    it('asks without the option when no session turn is running', async () => {
      const { handler, confirm, confirmWithCheckbox, respond } = makeHandler();
      await handler.prompt(8, ['busy', 'remote-control'], update([]));
      expect(confirmWithCheckbox).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'app.updateRestartTitle',
          message: 'app.updateRestartMessage\n\napp.updateRestartMessageRemoteControl',
          variant: 'primary',
        }),
      );
      expect(respond).toHaveBeenCalledWith('quit', 8, false);
    });
  });
});

describe('useQuitConfirm', () => {
  it('returns a no-op cleanup without the desktop bridge', () => {
    const off = useQuitConfirm({
      confirm: vi.fn(),
      confirmWithCheckbox: vi.fn(),
      cancelCurrent: vi.fn(),
      isBusy: () => false,
      isOverlayOpen: () => false,
      t: (key) => key,
    });
    expect(() => off()).not.toThrow();
  });

  it('subscribes to prompt and cancel events and unsubscribes on cleanup', async () => {
    type PromptListener = (requestId: number, reasons: QuitBlockReason[], details: QuitConfirmDetails) => void;
    const promptListeners = new Set<PromptListener>();
    const cancelListeners = new Set<(requestId: number) => void>();
    const respondQuitConfirm = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      kimiDesktop: {
        onQuitConfirm: (cb: PromptListener) => {
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
      const confirmWithCheckbox = vi.fn().mockResolvedValue({ confirmed: true, checked: true });
      const off = useQuitConfirm({
        confirm,
        confirmWithCheckbox,
        cancelCurrent: vi.fn(),
        isBusy: () => false,
        isOverlayOpen: () => false,
        t: (key) => key,
      });
      expect(promptListeners.size).toBe(1);
      expect(cancelListeners.size).toBe(1);
      for (const cb of promptListeners) cb(11, ['busy'], QUIT_DETAILS);
      await flush();
      expect(confirm).toHaveBeenCalledOnce();
      expect(respondQuitConfirm).toHaveBeenCalledWith('quit', 11, false);

      for (const cb of promptListeners) cb(12, ['busy'], update(['Fix login bug']));
      await flush();
      expect(confirmWithCheckbox).toHaveBeenCalledOnce();
      expect(respondQuitConfirm).toHaveBeenCalledWith('quit', 12, true);

      off();
      expect(promptListeners.size).toBe(0);
      expect(cancelListeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
