import { Slice, type Node as PMNode } from 'prosemirror-model';
import { textToDoc } from './documentCodec';
import { buildQuoteWireLines, encodeQuoteSourceHeader } from './quoteBlocks';
import { composerSchema } from './schema';
import { serializeMention, type AttachmentAttrs, type MentionAttrs, type PastedTextAttrs, type QuoteAttrs } from './wireCodec';
export function parseClipboardText(text: string, opts?: { reviveMentions?: boolean }): Slice {
  return Slice.maxOpen(textToDoc(text.replace(/\r\n?/g, '\n'), opts).content);
}

function quoteWireText(attrs: QuoteAttrs): string {
  const header = typeof attrs.source === 'string' && attrs.source.length > 0 ? `from: ${encodeQuoteSourceHeader(attrs.source)}\n` : '';
  const comment = typeof attrs.comment === 'string' && attrs.comment.length > 0 ? `\n\n${attrs.comment}` : '';
  return `${header}${buildQuoteWireLines(attrs.text)}${comment}`;
}

export function serializeClipboardSlice(slice: Slice, browserText?: (refId: string, label: string) => string): string {
  const serializeInline = (node: PMNode): string => {
    if (node.isText) return node.text ?? '';
    if (node.type === composerSchema.nodes.mention) return serializeMention(node.attrs as MentionAttrs);
    if (node.type === composerSchema.nodes.attachment) {
      const attrs = node.attrs as AttachmentAttrs;
      return attrs.name + (attrs.comment ? `\n${attrs.comment}` : '');
    }
    if (node.type === composerSchema.nodes.quote) return quoteWireText(node.attrs as QuoteAttrs);
    if (node.type === composerSchema.nodes.pasted_text) return (node.attrs as PastedTextAttrs).text;
    if (node.type === composerSchema.nodes.browser_reference) return browserText?.(node.attrs.refId as string, node.attrs.label as string) ?? node.attrs.label as string;
    return node.textBetween(0, node.content.size, '');
  };
  const lines: string[] = [];
  slice.content.forEach((node) => {
    if (node.type === composerSchema.nodes.mention || node.type === composerSchema.nodes.attachment || node.type === composerSchema.nodes.quote || node.type === composerSchema.nodes.pasted_text || node.type === composerSchema.nodes.browser_reference) {
      lines.push(serializeInline(node));
    } else {
      let line = '';
      let pendingBreak = false;
      node.forEach((child) => {
        if (child.type === composerSchema.nodes.quote) {
          const degrade = quoteWireText(child.attrs as QuoteAttrs);
          line = line.length > 0 ? `${line.replace(/ +$/, '')}\n\n${degrade}` : degrade;
          pendingBreak = true;
          return;
        }
        let text = serializeInline(child);
        if (pendingBreak) {
          text = text.replace(/^ /, '');
          line += '\n\n';
          pendingBreak = false;
        }
        line += text;
      });
      lines.push(line);
    }
  });
  return lines.join('\n');
}
