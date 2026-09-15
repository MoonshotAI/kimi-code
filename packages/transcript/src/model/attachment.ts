import type { AttachmentId } from './ids';

export type AttachmentSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly fileId: string }
  | { readonly kind: 'session_media'; readonly fileId: string };

export interface TranscriptAttachment {
  readonly attachmentId: AttachmentId;
  readonly mediaType: string;
  readonly name?: string;
  readonly size?: number;
  readonly source?: AttachmentSource;
  readonly placeholder?: string;
}
