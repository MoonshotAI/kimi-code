import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirmDialog } from '../../../../packages/app-client/src/composables/useConfirmDialog';

const openDialog = vi.fn();
const closeDialog = vi.fn();
let actionListener: ((payload: { dialogId: string; action: 'confirm' | 'cancel' }) => void) | undefined;
let closedListener: ((payload: { dialogId: string; reason: 'escape' }) => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  actionListener = undefined;
  closedListener = undefined;
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('window', {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    kimiDesktop: {
      browserOverlayOpenDialog: openDialog,
      browserOverlayCloseDialog: closeDialog,
      onBrowserOverlayDialogAction: (cb: typeof actionListener) => {
        actionListener = cb;
        return vi.fn();
      },
      onBrowserOverlayDialogClosed: (cb: typeof closedListener) => {
        closedListener = cb;
        return vi.fn();
      },
    },
  });
});

describe('browser overlay dialog renderer adapter', () => {
  it('shows bounded data, routes actions and closes by id', async () => {
    const { canUseBrowserOverlayDialog, registerBrowserOverlayDialog } =
      await import('../../src/renderer/lib/browserOverlayDialog');
    expect(canUseBrowserOverlayDialog()).toBe(true);
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const dialog = registerBrowserOverlayDialog({
      id: 'global-confirm',
      onConfirm,
      onCancel,
    });
    dialog.show({
      title: 'Clear browsing data',
      message: 'Cookies will be deleted.',
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'danger',
      loading: false,
    });
    expect(openDialog).toHaveBeenCalledWith({
      dialogId: 'global-confirm',
      title: 'Clear browsing data',
      message: 'Cookies will be deleted.',
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'danger',
      loading: false,
      viewport: { width: 1200, height: 800 },
    });

    actionListener?.({ dialogId: 'other', action: 'confirm' });
    actionListener?.({ dialogId: 'global-confirm', action: 'confirm' });
    actionListener?.({ dialogId: 'global-confirm', action: 'cancel' });
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();

    dialog.close();
    expect(closeDialog).toHaveBeenCalledWith('global-confirm');
    closedListener?.({ dialogId: 'global-confirm', reason: 'escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('routes actions and closed events only for the latest generation', async () => {
    const { registerBrowserOverlayDialog } = await import('../../src/renderer/lib/browserOverlayDialog');
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const dialog = registerBrowserOverlayDialog({
      id: 'global-confirm',
      onConfirm,
      onCancel,
    });
    const request = {
      title: 'Clear browsing data',
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
    };
    dialog.show(request, '1');
    expect(openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: 'global-confirm:1' }));
    dialog.show(request, '2');
    expect(openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: 'global-confirm:2' }));

    actionListener?.({ dialogId: 'global-confirm:1', action: 'confirm' });
    closedListener?.({ dialogId: 'global-confirm:1', reason: 'escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    actionListener?.({ dialogId: 'global-confirm:2', action: 'confirm' });
    expect(onConfirm).toHaveBeenCalledOnce();

    dialog.close();
    expect(closeDialog).toHaveBeenCalledWith('global-confirm:2');
  });

  it('does not settle the active confirm when a replaced dialog emits a stale action', async () => {
    const { registerBrowserOverlayDialog } = await import('../../src/renderer/lib/browserOverlayDialog');
    const { current, confirm, settle, runAction } = useConfirmDialog();
    const dialog = registerBrowserOverlayDialog({
      id: 'global-confirm',
      onConfirm: () => {
        void runAction();
      },
      onCancel: () => settle(false),
    });
    const showCurrent = (): void => {
      const req = current.value;
      if (req === null) {
        dialog.close();
        return;
      }
      dialog.show({
        title: req.title,
        confirmLabel: req.confirmLabel ?? 'Confirm',
        cancelLabel: req.cancelLabel ?? 'Cancel',
        closeLabel: 'Close',
        variant: req.variant ?? 'danger',
      }, String(req.seq));
    };

    const first = confirm({ title: 'First' });
    showCurrent();
    expect(openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: 'global-confirm:1' }));

    const second = confirm({ title: 'Quit?' });
    showCurrent();
    await expect(first).resolves.toBe(false);
    expect(openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ dialogId: 'global-confirm:2' }));

    actionListener?.({ dialogId: 'global-confirm:1', action: 'confirm' });
    let secondSettled: boolean | null = null;
    void second.then((ok) => {
      secondSettled = ok;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBeNull();

    actionListener?.({ dialogId: 'global-confirm:2', action: 'confirm' });
    await expect(second).resolves.toBe(true);
  });
});
