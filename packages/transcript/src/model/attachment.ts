import type { AttachmentId } from './ids';

/**
 * Where the frontend fetches the bytes. `file` addresses the process-global
 * upload store; `session_media` addresses canonical media owned by the
 * transcript's session. Inline base64 data is deliberately dropped rather
 * than shipped over the transcript API.
 */
export type AttachmentSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly fileId: string }
  | { readonly kind: 'session_media'; readonly fileId: string };

export interface TranscriptAttachment {
  readonly attachmentId: AttachmentId;
  /** e.g. 'image/png'. */
  readonly mediaType: string;
  /** Original filename, when known. */
  readonly name?: string;
  readonly size?: number;
  readonly source?: AttachmentSource;
  /** Inline position marker inside the carrier's text, e.g. '[Image #1]'. */
  readonly placeholder?: string;
}
