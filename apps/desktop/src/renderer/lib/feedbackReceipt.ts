import { dismissToastByKey, nextToastKey, onToast, toast } from '@moonshot-ai/app-client/client';
import type { ToastOptions } from '@moonshot-ai/app-ui';
import { getKimiWebApi } from '../api';
import { i18n } from '../i18n';
import { collectFeedbackDiagnostics } from './feedbackDiagnostics';
import { classifyFeedbackClientError } from './feedbackTelemetry';
import { track } from './track';

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
  async function upload(files: readonly FeedbackAttachment[], attempt: 'initial' | 'retry'): Promise<FeedbackAttachment[]> {
    const failed: FeedbackAttachment[] = [];
    for (const item of files) {
      const startedAt = Date.now();
      const sessionId = item.kind === 'session' ? item.sessionId : undefined;
      const hostKind = item.kind === 'session' ? (globalFeedback?.hostId === undefined ? ('local' as const) : ('ssh' as const)) : undefined;
      const mediaKind = item.kind === 'media' ? (item.file.type.startsWith('video/') ? ('video' as const) : ('image' as const)) : undefined;
      let sizeBytes = item.kind === 'media' ? item.file.size : undefined;
      const base = () => ({
        emitter: 'client' as const,
        attachment_kind: item.kind,
        duration_ms: Date.now() - startedAt,
        feedback_id: feedbackId,
        attempt,
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        ...(hostKind === undefined ? {} : { host_kind: hostKind }),
        ...(mediaKind === undefined ? {} : { media_kind: mediaKind }),
        ...(sizeBytes === undefined ? {} : { size_bytes: sizeBytes }),
      });
      if (signal.aborted) {
        track('feedback_attachment_upload', { ...base(), stage: 'authorize', outcome: 'aborted', error_class: 'aborted' });
        break;
      }
      let stage: 'authorize' | 'collect' | 'upload' = item.kind === 'diagnostics' ? 'collect' : item.kind === 'session' ? 'authorize' : 'upload';
      let uploadSignal = signal;
      try {
        const api = getKimiWebApi();
        if (item.kind === 'session') {
          if (globalFeedback?.authorizeSession !== undefined) {
            const host = await globalFeedback.authorizeSession();
            if (host === undefined) {
              track('feedback_attachment_upload', {
                ...base(),
                stage: 'authorize',
                outcome: signal.aborted ? 'aborted' : 'skipped',
                error_class: signal.aborted ? 'aborted' : 'ownership_unverified',
              });
              failed.push(item);
              continue;
            }
            uploadSignal = AbortSignal.any([signal, host]);
          }
          uploadSignal.throwIfAborted();
          stage = 'upload';
          const uploaded = await api.uploadFeedbackSession(feedbackId, item.sessionId, uploadSignal, globalFeedback && { hostId: globalFeedback.hostId });
          track('feedback_attachment_upload', {
            ...base(), stage, outcome: 'succeeded',
            ...(uploaded?.upload_id === undefined ? {} : { upload_id: uploaded.upload_id }),
          });
        } else {
          const file = item.kind === 'media' ? item.file : (diagnostics ??= await collectFeedbackDiagnostics());
          sizeBytes = file.size;
          signal.throwIfAborted();
          stage = 'upload';
          const uploaded = await api.uploadFeedbackAttachment(feedbackId, { kind: item.kind, file, fileName: file.name }, signal);
          track('feedback_attachment_upload', {
            ...base(), stage, outcome: 'succeeded',
            ...(uploaded?.upload_id === undefined ? {} : { upload_id: uploaded.upload_id }),
          });
        }
      } catch (error) {
        const failure = classifyFeedbackClientError(error, uploadSignal);
        track('feedback_attachment_upload', {
          ...base(),
          stage,
          outcome: failure.error_class === 'aborted' ? 'aborted' : 'failed',
          ...failure,
        });
        if (signal.aborted) break;
        handleLoginError(error, sessionId);
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
      const failed = await upload(files, 'retry');
      if (!dismissProgress()) return;
      if (failed.length > 0) showFailedAttachments(failed);
      else showFeedbackToast({ variant: 'success', title: t('feedback.uploadComplete', { names: attachmentNames(files) }) }, signal);
    }
  }

  void upload(attachments, 'initial').then(failed => {
    if (failed.length > 0) showFailedAttachments(failed);
  });
}
