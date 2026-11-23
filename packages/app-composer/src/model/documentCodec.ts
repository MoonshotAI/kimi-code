import type { Node as PMNode } from 'prosemirror-model';
import { attachmentNode, browserReferenceNode, composerSchema, mentionNode, pastedTextNode, quoteNode } from './schema';
import { splitInlineSegments, type AttachmentKindSource } from './inlineLinks';
import { mentionActionPath } from './wireCodec';
function lineToInlineNodes(line: string, attachmentKindFor?: AttachmentKindSource): PMNode[] {
  if (!line) return [];
  return splitInlineSegments(line, attachmentKindFor).map((segment) => {
    if (segment.type === 'mention') {
      const pathLike = segment.attrs.kind === 'file' || segment.attrs.kind === 'folder';
      const rawDest = pathLike && mentionActionPath(segment.rawDest) !== segment.rawDest ? segment.rawDest : undefined;
      return mentionNode({ ...segment.attrs, rawDest });
    }
    if (segment.type === 'attachment') return attachmentNode(segment.attrs);
    if (segment.type === 'quote') return quoteNode(segment.attrs);
    if (segment.type === 'browser-reference') return browserReferenceNode(segment.attrs);
    if (segment.type === 'pasted-text') return pastedTextNode(segment.attrs);
    return composerSchema.text(segment.value);
  });
}

export function textToDoc(text: string, opts?: { reviveMentions?: boolean; attachmentKindFor?: AttachmentKindSource }): PMNode {
  const lines = text.split('\n');
  return composerSchema.node(
    'doc',
    null,
    lines.map((line) => {
      if (!line) return composerSchema.node('paragraph');
      return composerSchema.node(
        'paragraph',
        null,
        opts?.reviveMentions ? lineToInlineNodes(line, opts?.attachmentKindFor) : composerSchema.text(line),
      );
    }),
  );
}

export function docToText(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, '\n');
}
