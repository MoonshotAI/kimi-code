import { dismissToastByKey, nextToastKey, onToast, toast } from '@moonshot-ai/app-client/client';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import { getKimiWebApi } from '../api';
import { i18n } from '../i18n';
import { collectFeedbackDiagnostics } from './feedbackDiagnostics';

export type FeedbackAttachment =
  | { kind: 'media'; file: File }
  | { kind: 'diagnostics' }
  | { kind: 'session'; sessionId: string };

const { t } = i18n.global;

function showFeedbackToast(options: ToastOptions, signal: AbortSignal): () => boolean {
  if (signal.aborted) return () => false;
  const key = nextToastKey();
  let visible = true;
  const dismiss = (): boolean => {
    if (!visible) return false;
    dismissToastByKey(key);
    return true;
  };
  const unsubscribe = onToast(event => {
    if (event.type !== 'dismiss' || event.key !== key) return;
    visible = false;
    unsubscribe();
    signal.removeEventListener('abort', dismiss);
  });
  signal.addEventListener('abort', dismiss, { once: true });
  toast(options, key);
  return dismiss;
}

export function showFeedbackError(message: string, signal: AbortSignal): void {
  showFeedbackToast({ variant: 'danger', title: t(message) }, signal);
}

function attachmentNames(items: readonly FeedbackAttachment[]): string {
  return items.map(item => {
    if (item.kind === 'media') return item.file.name;
    return t(item.kind === 'session' ? 'feedback.sessionFile' : 'feedback.diagnosticsFile');
  }).join(t('feedback.fileSeparator'));
}

export function showFeedbackReceipt(
  feedbackId: number,
  attachments: readonly FeedbackAttachment[],
  signal: AbortSignal,
  handleLoginError: (error: unknown, sessionId?: string) => boolean,
  globalFeedback?: { hostId?: string; authorizeSession?: () => Promise<AbortSignal | undefined> },
): void {
  showFeedbackToast({
    variant: 'success',
    title: t('feedback.submittedId', { id: feedbackId }),
    copyLink: { url: String(feedbackId), label: t('feedback.copyId'), copiedLabel: t('warnings.copied') },
  }, signal);
  if (attachments.length === 0) return;

  let diagnostics: File | undefined;
  async function upload(files: readonly FeedbackAttachment[]): Promise<FeedbackAttachment[]> {
    const failed: FeedbackAttachment[] = [];
    for (const item of files) {
      if (signal.aborted) break;
      try {
        const api = getKimiWebApi();
        if (item.kind === 'session') {
          let uploadSignal = signal;
          if (globalFeedback?.authorizeSession !== undefined) {
            const host = await globalFeedback.authorizeSession();
            if (host === undefined) {
              failed.push(item);
              continue;
            }
            uploadSignal = AbortSignal.any([signal, host]);
          }
          uploadSignal.throwIfAborted();
          await api.uploadFeedbackSession(feedbackId, item.sessionId, uploadSignal, globalFeedback && { hostId: globalFeedback.hostId });
        } else {
          const file = item.kind === 'media' ? item.file : (diagnostics ??= await collectFeedbackDiagnostics());
          signal.throwIfAborted();
          await api.uploadFeedbackAttachment(feedbackId, { kind: item.kind, file, fileName: file.name }, signal);
        }
      } catch (error) {
        if (signal.aborted) break;
        handleLoginError(error, item.kind === 'session' ? item.sessionId : undefined);
        failed.push(item);
      }
    }
    return failed;
  }

  function showFailedAttachments(files: readonly FeedbackAttachment[]): void {
    const dismissFailure = showFeedbackToast({
      variant: 'danger',
      title: t('feedback.uploadFailed', { names: attachmentNames(files) }),
      actions: [{ label: t('feedback.retryUpload'), onClick: retry }],
    }, signal);

    async function retry(): Promise<void> {
      if (!dismissFailure()) return;
      const dismissProgress = showFeedbackToast({
        layout: 'bar', title: t('feedback.uploading'), running: true, duration: 0,
      }, signal);
      const failed = await upload(files);
      if (!dismissProgress()) return;
      if (failed.length > 0) showFailedAttachments(failed);
      else showFeedbackToast({ variant: 'success', title: t('feedback.uploadComplete', { names: attachmentNames(files) }) }, signal);
    }
  }

  void upload(attachments).then(failed => {
    if (failed.length > 0) showFailedAttachments(failed);
  });
}
