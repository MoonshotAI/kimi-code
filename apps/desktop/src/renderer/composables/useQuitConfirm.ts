import type { ConfirmOptions } from '@moonshot-ai/app-client/composables';
import type { Translator } from '@moonshot-ai/app-core/contracts';

type QuitConfirmChoice = 'quit' | 'cancel' | 'unavailable';
type QuitBlockReason = 'busy' | 'remote-control';

interface QuitConfirmBridge {
  onQuitConfirm: (cb: (requestId: number, reasons: QuitBlockReason[]) => void) => () => void;
  onQuitConfirmCancel: (cb: (requestId: number) => void) => () => void;
  respondQuitConfirm: (choice: QuitConfirmChoice, requestId: number) => Promise<void>;
}

function bridge(): QuitConfirmBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { kimiDesktop?: QuitConfirmBridge }).kimiDesktop;
}

function quitConfirmMessageKey(reasons: QuitBlockReason[]): string {
  const busy = reasons.includes('busy');
  const remoteControl = reasons.includes('remote-control');
  if (busy && remoteControl) return 'app.quitConfirmMessageBusyAndRemoteControl';
  if (remoteControl) return 'app.quitConfirmMessageRemoteControl';
  return 'app.quitConfirmMessage';
}

export function createQuitConfirmHandler(options: {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  cancelCurrent: () => void;
  isBusy: () => boolean;
  isOverlayOpen: () => boolean;
  respond: (choice: QuitConfirmChoice, requestId: number) => void;
  t: Translator;
}): { prompt: (requestId: number, reasons: QuitBlockReason[]) => Promise<void>; cancel: (requestId: number) => void } {
  let activeRequestId: number | null = null;
  return {
    async prompt(requestId, reasons) {
      if (activeRequestId !== null) return;
      if (options.isBusy() || options.isOverlayOpen()) {
        options.respond('unavailable', requestId);
        return;
      }
      activeRequestId = requestId;
      try {
        const quit = await options.confirm({
          title: options.t('app.quitConfirmTitle'),
          message: options.t(quitConfirmMessageKey(reasons)),
          confirmLabel: options.t('app.quitConfirmQuit'),
          cancelLabel: options.t('app.quitConfirmCancel'),
          variant: 'danger',
          initialFocus: 'cancel',
        });
        if (activeRequestId === requestId) {
          options.respond(quit ? 'quit' : 'cancel', requestId);
        }
      } finally {
        if (activeRequestId === requestId) activeRequestId = null;
      }
    },
    cancel(requestId) {
      if (activeRequestId !== requestId) return;
      activeRequestId = null;
      options.cancelCurrent();
    },
  };
}

export function useQuitConfirm(options: {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  cancelCurrent: () => void;
  isBusy: () => boolean;
  isOverlayOpen: () => boolean;
  t: Translator;
}): () => void {
  const quitConfirmBridge = bridge();
  if (quitConfirmBridge === undefined) return () => undefined;
  const handler = createQuitConfirmHandler({
    confirm: options.confirm,
    cancelCurrent: options.cancelCurrent,
    isBusy: options.isBusy,
    isOverlayOpen: options.isOverlayOpen,
    t: options.t,
    respond: (choice, requestId) => void quitConfirmBridge.respondQuitConfirm(choice, requestId),
  });
  const offPrompt = quitConfirmBridge.onQuitConfirm((requestId, reasons) => void handler.prompt(requestId, reasons));
  const offCancel = quitConfirmBridge.onQuitConfirmCancel((requestId) => handler.cancel(requestId));
  return () => {
    offPrompt();
    offCancel();
  };
}
