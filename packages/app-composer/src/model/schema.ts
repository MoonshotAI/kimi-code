import { Schema, type Node as PMNode } from 'prosemirror-model';
import { quotePillLabel, serializeAttachment, serializeMention, serializeQuote, type AttachmentAttrs, type MentionAttrs, type QuoteAttrs } from './wireCodec';
import { pastedTextPillLabel, serializeBrowserReference, serializePastedText, type BrowserReferenceAttrs, type PastedTextAttrs } from './wireCodec';
export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
    browser_reference: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { refId: {}, label: {} },
      leafText: (node: PMNode) => serializeBrowserReference(node.attrs as BrowserReferenceAttrs),
      toDOM: (node: PMNode) => ['span', { class: 'browser-reference-pill', 'data-browser-ref-id': node.attrs.refId }, node.attrs.label],
    },
    mention: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        kind: {},
        name: {},
        path: { default: '' },
        rawDest: { default: undefined },
      },
      leafText: (node: PMNode) => serializeMention(node.attrs as MentionAttrs),
      toDOM: (node: PMNode) => {
        const attrs = node.attrs as MentionAttrs;
        return [
          'span',
          { class: `mention-pill mention-${attrs.kind}`, 'data-mention-path': attrs.path },
          attrs.name,
        ];
      },
    },
    attachment: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        attId: {},
        name: {},
        kind: {},
        comment: { default: undefined },
      },
      leafText: (node: PMNode) => serializeAttachment(node.attrs as AttachmentAttrs),
      toDOM: (node: PMNode) => {
        const attrs = node.attrs as AttachmentAttrs;
        return [
          'span',
          {
            class: `attachment-pill attachment-${attrs.kind}`,
            'data-attachment-id': attrs.attId,
            'data-attachment-kind': attrs.kind,
            'data-attachment-name': attrs.name,
            'data-attachment-comment': attrs.comment,
          },
          attrs.name + (attrs.comment ? `\n${attrs.comment}` : ''),
        ];
      },
    },
    quote: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        text: {},
        comment: { default: '' },
        source: { default: '' },
      },
      leafText: (node: PMNode) => serializeQuote(node.attrs as QuoteAttrs),
      toDOM: (node: PMNode) => {
        const attrs = node.attrs as QuoteAttrs;
        const dataAttrs: Record<string, string> = { class: 'quote-pill', 'data-quote-text': attrs.text };
        if (typeof attrs.comment === 'string' && attrs.comment.length > 0) dataAttrs['data-quote-comment'] = attrs.comment;
        if (typeof attrs.source === 'string' && attrs.source.length > 0) dataAttrs['data-quote-source'] = attrs.source;
        return ['span', dataAttrs, quotePillLabel(attrs.text)];
      },
    },
    pasted_text: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: { text: {} },
      leafText: (node: PMNode) => serializePastedText(node.attrs as PastedTextAttrs),
      toDOM: (node: PMNode) => ['span', { class: 'quote-pill pasted-text-pill' }, pastedTextPillLabel((node.attrs as PastedTextAttrs).text)],
    },
  },
});

export function mentionNode(attrs: MentionAttrs): PMNode {
  return composerSchema.nodes.mention!.create(attrs);
}

export function attachmentNode(attrs: AttachmentAttrs): PMNode {
  return composerSchema.nodes.attachment!.create(attrs);
}

export function quoteNode(attrs: QuoteAttrs): PMNode {
  return composerSchema.nodes.quote!.create(attrs);
}

export function browserReferenceNode(attrs: BrowserReferenceAttrs): PMNode {
  return composerSchema.nodes.browser_reference!.create(attrs);
}

export function pastedTextNode(attrs: PastedTextAttrs): PMNode {
  return composerSchema.nodes.pasted_text!.create(attrs);
}
