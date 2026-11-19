import { h, shallowRef } from 'vue';
import { toast } from '@moonshot-ai/app-client/client';
import { getKimiWebApi } from '../api';
import FeedbackReceipt from '../components/feedback/FeedbackReceipt.vue';
import { collectFeedbackDiagnostics } from './feedbackDiagnostics';

export type FeedbackAttachment =
  | { kind: 'media'; file: File }
  | { kind: 'diagnostics' }
  | { kind: 'session'; sessionId: string };

type UploadNotice =
  | { kind: 'upload'; failed: readonly FeedbackAttachment[]; retry: () => void }
  | { kind: 'retrying' }
  | { kind: 'uploaded'; files: readonly FeedbackAttachment[] };

export type FeedbackNotice = UploadNotice
  | { kind: 'submitted'; feedbackId: number }
  | { kind: 'error'; message: string };

function showNotice(notice: () => FeedbackNotice, signal: AbortSignal): void {
  toast({
    position: 'top-center',
    presentation: ({ dismiss }) => h(FeedbackReceipt, { notice: notice(), signal, dismiss }),
  });
}

export function showFeedbackError(message: string, signal: AbortSignal): void {
  const notice = { kind: 'error', message } as const;
  showNotice(() => notice, signal);
}

export function showFeedbackReceipt(
  feedbackId: number,
  attachments: readonly FeedbackAttachment[],
  signal: AbortSignal,
  handleLoginError: (error: unknown, sessionId?: string) => boolean,
  authorizeSession?: () => Promise<AbortSignal | undefined>,
): void {
  const receipt = { kind: 'submitted', feedbackId } as const;
  showNotice(() => receipt, signal);
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
          if (authorizeSession !== undefined) {
            const host = await authorizeSession();
            if (host === undefined) {
              failed.push(item);
              continue;
            }
            uploadSignal = AbortSignal.any([signal, host]);
          }
          uploadSignal.throwIfAborted();
          await api.uploadFeedbackSession(feedbackId, item.sessionId, uploadSignal);
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

  void upload(attachments).then(failed => {
    if (signal.aborted || failed.length === 0) return;
    const notice = shallowRef<UploadNotice>({ kind: 'upload', failed, retry });
    showNotice(() => notice.value, signal);

    function retry(): void {
      if (notice.value.kind !== 'upload' || signal.aborted) return;
      const files = notice.value.failed;
      notice.value = { kind: 'retrying' };
      void upload(files).then(failedAgain => {
        if (signal.aborted) return;
        notice.value = failedAgain.length === 0 ? { kind: 'uploaded', files } : { kind: 'upload', failed: failedAgain, retry };
      });
    }
  });
}
