// packages/app-composer/src/attachmentTarget.ts
// Message-side attachment-pill → open-target mapping. On submit, the outgoing
// text's file-attachment links are rewritten to 1..N indexes in first-mention
// order (rewriteAttachmentLinksForSubmit), matching the message's file
// attachments in payload/notice order — the model and the trailing
// attachments notice correlate by the same position. A bubble revives each
// pill's open target by counting the message's FILE attachments back up to
// the pill's index; media attachments never travel as inline pills (they are
// chips, unreferenced by links), so they don't consume an index.

/** Map a message-side attachment pill's attId — the submit-time 1..N index
 *  over the message's file attachments — back to that attachment. Returns
 *  undefined for anything that cannot resolve: no list, a non-index attId
 *  (a composer-private id leaking onto the message surface must never alias
 *  a rewritten index), or an index past the file count. Generic over the
 *  attachment shape so this pure layer stays free of client types. */
export function attachmentTargetFor<T extends { kind: string }>(
  attId: string,
  attachments: readonly T[] | undefined,
): T | undefined {
  if (attachments === undefined || !/^[1-9]\d*$/.test(attId)) return undefined;
  const index = Number(attId);
  let position = 0;
  for (const att of attachments) {
    if (att.kind !== 'file') continue;
    position += 1;
    if (position === index) return att;
  }
  return undefined;
}

/** The data attributes a message-side attachment pill carries, keyed off its
 *  resolved open target: metadata (file id, media type, size) whenever the
 *  target resolves, plus the open affordance (url, tabindex, role) ONLY when
 *  the pill can actually open — a non-empty url (an inline-base64 attachment
 *  carries no fileId, so it stays an inert pill, but its size still shows in
 *  the hover tooltip per DesignSystemView §05's name + size-tail recipe).
 *  Undefined values are dropped by the renderer's v-bind. */
export interface AttachmentTargetAttrs {
  'data-attachment-url'?: string;
  'data-attachment-file-id'?: string;
  'data-attachment-media-type'?: string;
  'data-attachment-size'?: number;
  tabindex?: number;
  role?: string;
}

export function attachmentTargetAttrs<
  T extends { kind: string; url: string; fileId?: string; mediaType?: string; size?: number },
>(attId: string, attachments: readonly T[] | undefined): AttachmentTargetAttrs {
  const target = attachmentTargetFor(attId, attachments);
  if (target === undefined) return {};
  const openable = target.url !== '';
  return {
    'data-attachment-url': openable ? target.url : undefined,
    'data-attachment-file-id': target.fileId,
    'data-attachment-media-type': target.mediaType,
    'data-attachment-size': target.size,
    tabindex: openable ? 0 : undefined,
    role: openable ? 'button' : undefined,
  };
}
