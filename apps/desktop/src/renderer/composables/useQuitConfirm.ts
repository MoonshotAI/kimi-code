import type { ConfirmCheckbox, ConfirmCheckboxResult, ConfirmOptions } from '@moonshot-ai/app-client/composables';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { updateRestartMessage, type QuitBlockReason, type QuitConfirmDetails } from '../../shared/quit-confirm';

type QuitConfirmChoice = 'quit' | 'cancel' | 'unavailable';

type ConfirmWithCheckbox = (
  options: ConfirmOptions & { checkbox: ConfirmCheckbox },
) => Promise<ConfirmCheckboxResult>;

interface QuitConfirmBridge {
  onQuitConfirm: (
    cb: (requestId: number, reasons: QuitBlockReason[], details: QuitConfirmDetails) => void,
  ) => () => void;
  onQuitConfirmCancel: (cb: (requestId: number) => void) => () => void;
  respondQuitConfirm: (choice: QuitConfirmChoice, requestId: number, continueSessions: boolean) => Promise<void>;
}

const QUIT_DETAILS: QuitConfirmDetails = { purpose: 'quit', sessionTitles: [] };

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
  confirmWithCheckbox: ConfirmWithCheckbox;
  cancelCurrent: () => void;
  isBusy: () => boolean;
  isOverlayOpen: () => boolean;
  respond: (choice: QuitConfirmChoice, requestId: number, continueSessions: boolean) => void;
  t: Translator;
}): {
  prompt: (requestId: number, reasons: QuitBlockReason[], details?: QuitConfirmDetails) => Promise<void>;
  cancel: (requestId: number) => void;
} {
  const { t } = options;

  async function askQuit(reasons: QuitBlockReason[]): Promise<ConfirmCheckboxResult> {
    const confirmed = await options.confirm({
      title: t('app.quitConfirmTitle'),
      message: t(quitConfirmMessageKey(reasons)),
      confirmLabel: t('app.quitConfirmQuit'),
      cancelLabel: t('app.quitConfirmCancel'),
      variant: 'danger',
      initialFocus: 'cancel',
    });
    return { confirmed, checked: false };
  }

  async function askUpdateRestart(
    reasons: QuitBlockReason[],
    sessionTitles: readonly string[],
  ): Promise<ConfirmCheckboxResult> {
    const dialog: ConfirmOptions = {
      title: t('app.updateRestartTitle'),
      message: updateRestartMessage(
        {
          busy: t('app.updateRestartMessage'),
          sessions: t('app.updateRestartMessageSessions'),
          moreSessions: (count) => t('app.updateRestartMoreSessions', { count }),
          remoteControl: t('app.updateRestartMessageRemoteControl'),
        },
        reasons,
        sessionTitles,
      ),
      confirmLabel: t('app.updateRestartConfirm'),
      cancelLabel: t('app.quitConfirmCancel'),
      variant: 'primary',
      initialFocus: 'cancel',
    };
    if (sessionTitles.length === 0) return { confirmed: await options.confirm(dialog), checked: false };
    return options.confirmWithCheckbox({
      ...dialog,
      checkbox: { label: t('app.updateRestartContinueSessions'), checked: true },
    });
  }

  let activeRequestId: number | null = null;
  return {
    async prompt(requestId, reasons, details = QUIT_DETAILS) {
      if (activeRequestId !== null) return;
      if (options.isBusy() || options.isOverlayOpen()) {
        options.respond('unavailable', requestId, false);
        return;
      }
      activeRequestId = requestId;
      try {
        const answer =
          details.purpose === 'update'
            ? await askUpdateRestart(reasons, details.sessionTitles)
            : await askQuit(reasons);
        if (activeRequestId === requestId) {
          options.respond(answer.confirmed ? 'quit' : 'cancel', requestId, answer.confirmed && answer.checked);
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
  confirmWithCheckbox: ConfirmWithCheckbox;
  cancelCurrent: () => void;
  isBusy: () => boolean;
  isOverlayOpen: () => boolean;
  t: Translator;
}): () => void {
  const quitConfirmBridge = bridge();
  if (quitConfirmBridge === undefined) return () => undefined;
  const handler = createQuitConfirmHandler({
    confirm: options.confirm,
    confirmWithCheckbox: options.confirmWithCheckbox,
    cancelCurrent: options.cancelCurrent,
    isBusy: options.isBusy,
    isOverlayOpen: options.isOverlayOpen,
    t: options.t,
    respond: (choice, requestId, continueSessions) =>
      void quitConfirmBridge.respondQuitConfirm(choice, requestId, continueSessions),
  });
  const offPrompt = quitConfirmBridge.onQuitConfirm(
    (requestId, reasons, details) => void handler.prompt(requestId, reasons, details),
  );
  const offCancel = quitConfirmBridge.onQuitConfirmCancel((requestId) => handler.cancel(requestId));
  return () => {
    offPrompt();
    offCancel();
  };
}
