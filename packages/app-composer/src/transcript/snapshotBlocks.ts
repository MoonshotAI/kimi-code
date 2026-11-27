import type { ComposerDocumentSnapshot, ComposerTextBlock, InlineSegment, MentionAttrs, AttachmentAttrs, BrowserReferenceAttrs, PastedTextAttrs } from '../model';

export type ComposerRenderBlock =
  | Extract<ComposerTextBlock, { type: 'quote' | 'sep' }>
  | { type: 'inline'; text: string; segments: Exclude<InlineSegment, { type: 'quote' }>[]; annotation?: boolean };

export function snapshotRenderBlocks(snapshot: ComposerDocumentSnapshot): ComposerRenderBlock[] {
  const blocks: ComposerRenderBlock[] = [];
  for (const [index, paragraph] of (snapshot.doc.content ?? []).entries()) {
    if (index > 0) blocks.push({ type: 'sep', text: '\n' });
    let segments: Exclude<InlineSegment, { type: 'quote' }>[] = [];
    const flush = (): void => {
      const only = segments.length === 1 ? segments[0] : undefined;
      if (segments.length > 0) blocks.push({ type: 'inline', text: '', segments, ...(only?.type === 'attachment' && only.attrs.comment ? { annotation: true } : {}) });
      segments = [];
    };
    for (const node of paragraph.content ?? []) {
      if (node.type === 'text') segments.push({ type: 'text', value: node.text ?? '' });
      else if (node.type === 'mention') segments.push({ type: 'mention', attrs: node.attrs as unknown as MentionAttrs, rawDest: typeof node.attrs?.['rawDest'] === 'string' ? node.attrs['rawDest'] : '' });
      else if (node.type === 'attachment') segments.push({ type: 'attachment', attrs: node.attrs as unknown as AttachmentAttrs, rawDest: '' });
      else if (node.type === 'browser_reference') segments.push({ type: 'browser-reference', attrs: node.attrs as unknown as BrowserReferenceAttrs, rawDest: '' });
      else if (node.type === 'pasted_text') segments.push({ type: 'pasted-text', attrs: node.attrs as unknown as PastedTextAttrs, rawDest: '' });
      else if (node.type === 'quote') {
        flush();
        blocks.push({ type: 'quote', text: node.attrs?.['text'] as string, comment: node.attrs?.['comment'] as string | undefined, source: node.attrs?.['source'] as string | undefined });
      }
    }
    flush();
  }
  return blocks;
}
