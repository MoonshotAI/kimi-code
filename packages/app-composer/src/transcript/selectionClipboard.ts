import { Slice, type Node as PMNode } from 'prosemirror-model';
import type { TurnAttachment } from '@moonshot-ai/app-core/client/types';
import { attachmentNode, browserReferenceNode, composerSchema, mentionNode, pastedTextNode, quoteNode } from '../model/schema';
import { composerSnapshotDocument, type ComposerDocumentSnapshot } from '../model/snapshot';
import { buildComposerClipboardCopy, messageCopyEntryFor, type ComposerClipboardCopy } from '../features/attachment/clipboard';
import { attachmentTargetFor } from '../features/attachment/target';
import type { AttachmentAttrs } from '../model/wireCodec';

export function renderedComposerSlice(fragment: DocumentFragment, snapshot?: ComposerDocumentSnapshot): Slice {
  const paragraphs: PMNode[] = [];
  let inline: PMNode[] = [];
  const flush = (): void => {
    paragraphs.push(composerSchema.nodes.paragraph.create(null, inline));
    inline = [];
  };
  const addText = (text: string): void => {
    for (const [index, line] of text.split('\n').entries()) {
      if (index > 0) flush();
      if (line !== '') inline.push(composerSchema.text(line));
    }
  };
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      addText(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      const el = node as Element;
      if (el.classList.contains('browser-reference-pill')) {
        const refId = el.getAttribute('data-browser-ref-id');
        if (refId !== null) {
          inline.push(browserReferenceNode({ refId, label: el.getAttribute('data-browser-ref-label') ?? el.querySelector('.quote-pill-name')?.textContent ?? '' }));
          return;
        }
      } else if (el.classList.contains('pasted-text-pill')) {
        const text = el.getAttribute('data-pasted-text');
        if (text !== null && text !== '') {
          inline.push(pastedTextNode({ text }));
          return;
        }
      } else if (el.classList.contains('quote-pill')) {
        inline.push(quoteNode({ text: el.getAttribute('data-quote-text') ?? el.textContent ?? '', comment: el.getAttribute('data-quote-comment') ?? '', source: el.getAttribute('data-quote-source') ?? '' }));
        return;
      } else if (el.classList.contains('mention-pill')) {
        const kind = el.getAttribute('data-mention-kind');
        if (kind === 'file' || kind === 'folder' || kind === 'skill' || kind === 'session') {
          inline.push(mentionNode({ kind, name: el.getAttribute('data-mention-name') ?? '', path: el.getAttribute('data-mention-path') ?? '', rawDest: el.getAttribute('data-mention-raw-dest') ?? undefined }));
          return;
        }
      } else if (el.classList.contains('attachment-pill')) {
        const kind = el.getAttribute('data-attachment-kind');
        const attId = el.getAttribute('data-attachment-id');
        if (attId !== null && (kind === 'file' || kind === 'folder' || kind === 'image' || kind === 'video')) {
          const comment = el.getAttribute('data-attachment-comment');
          inline.push(attachmentNode({ kind, attId, name: el.getAttribute('data-attachment-name') ?? el.textContent ?? '', ...(comment ? { comment } : {}) }));
          return;
        }
      } else if (snapshot === undefined && el.classList.contains('q-sep') && el.textContent === '\n\n' && el.previousSibling?.nodeType === 1 && el.nextSibling?.nodeType === 1 && (el.previousSibling as Element).matches('.quote-pill, [data-attachment-comment]') && (el.nextSibling as Element).matches('.quote-pill, [data-attachment-comment]')) {
        addText(' ');
        return;
      }
      if (el.tagName === 'BR') {
        flush();
        return;
      }
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(fragment);
  flush();
  return Slice.maxOpen(composerSchema.nodes.doc.create(null, paragraphs).content);
}

export function copyComposerSlice(slice: Slice, snapshot?: ComposerDocumentSnapshot, attachments?: readonly TurnAttachment[]): ComposerClipboardCopy | null {
  const attrs = new Map<string, AttachmentAttrs>();
  slice.content.descendants((node) => {
    if (node.type === composerSchema.nodes.attachment) attrs.set(node.attrs.attId as string, node.attrs as AttachmentAttrs);
  });
  const entries = new Map(snapshot?.attachments.map((entry) => [entry.attId, entry]));
  return buildComposerClipboardCopy(slice, (attId) => {
    const entry = entries.get(attId);
    if (entry !== undefined) return entry;
    const attr = attrs.get(attId);
    return attr === undefined ? undefined : messageCopyEntryFor(attr, attachmentTargetFor(attId, attachments));
  }, {
    references: new Map(snapshot?.browserReferences?.map((entry) => [entry.id, entry])),
    captures: new Map(snapshot?.browserCaptures?.map((entry) => [entry.id, entry])),
  });
}

export function copyComposerSnapshot(snapshot: ComposerDocumentSnapshot): ComposerClipboardCopy | null {
  return copyComposerSlice(Slice.maxOpen(composerSnapshotDocument(snapshot).content), snapshot);
}

export function composerSelectionRange(root: HTMLElement, selection: Selection): Range | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const liveRange = selection.getRangeAt(0);
  if (!root.contains(liveRange.commonAncestorContainer)) return null;
  const range = liveRange.cloneRange();
  const pillAt = (node: Node): Element | null => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('.quote-pill, .mention-pill, .attachment-pill') ?? null;
  const expand = (side: 'start' | 'end'): void => {
    const container = side === 'start' ? liveRange.startContainer : liveRange.endContainer;
    const offset = side === 'start' ? liveRange.startOffset : liveRange.endOffset;
    const pill = pillAt(container);
    if (pill === null || !root.contains(pill)) return;
    const probe = liveRange.cloneRange();
    probe.selectNodeContents(pill);
    if (side === 'start') probe.setStart(container, offset);
    else probe.setEnd(container, offset);
    if (probe.toString() === '') return;
    if (side === 'start') range.setStartBefore(pill);
    else range.setEndAfter(pill);
  };
  expand('start');
  expand('end');
  return range;
}
