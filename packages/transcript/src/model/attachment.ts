/**
 * TranscriptAttachment — a session-global attachment entity (image / video /
 * audio / file carried by a message).
 *
 * Media is heavy: bytes never cross the transcript API. The entity carries
 * only metadata plus a fetch reference (`source`), and lives beside
 * `tasks`/`interactions` — global per agent transcript, never paginated.
 * The timeline anchor is a typed id list on the carrier (`TranscriptTurn.
 * attachmentIds` for the turn-opening input, `TextFrame.attachmentIds` for
 * mid-conversation messages); a `placeholder` like `[Image #1]` marks the
 * inline position inside the carrier's text.
 */

import type { AttachmentId } from './ids';

/**
 * Where the frontend fetches the bytes. Mirrors the engine's media source
 * kinds minus `base64` — inline data is deliberately dropped rather than
 * shipped over the transcript API.
 */
export type AttachmentSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly fileId: string };

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
