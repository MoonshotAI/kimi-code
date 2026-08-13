// packages/app-client/src/lib/composerTextDoc.ts
// ProseMirror document model for the composer — deliberately minimal: the doc
// is a flat list of paragraphs holding plain text, one paragraph per line.
// This module is DOM-free (prosemirror-model only) so it stays importable from
// node-env tests; the EditorView factory lives in composerEditor.ts.
//
// The composer's wire format is still a single plain-text string, so this file
// owns the two-way mapping:
//   - text ↔ doc: lines split/join on '\n'
//   - char offsets ↔ PM positions: the '\n' between two paragraphs counts as
//     one character (matching textarea semantics), so offset math is the same
//     as `string` indexing into the serialized text.
import { Schema, Slice, type Node as PMNode } from 'prosemirror-model';

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
  },
});

/** Plain text → doc. Every '\n' starts a new paragraph; an empty string is a
 *  single empty paragraph (the schema requires at least one block). */
export function textToDoc(text: string): PMNode {
  const lines = text.split('\n');
  return composerSchema.node(
    'doc',
    null,
    lines.map((line) =>
      composerSchema.node('paragraph', null, line ? composerSchema.text(line) : undefined),
    ),
  );
}

/** Doc → plain text: paragraph texts joined with '\n'. */
export function docToText(doc: PMNode): string {
  const parts: string[] = [];
  doc.forEach((child) => {
    parts.push(child.textContent);
  });
  return parts.join('\n');
}

/** Map a char offset in the serialized text to a PM position. An offset that
 *  lands exactly on a '\n' maps to the end of the preceding paragraph's text;
 *  offsets past the end clamp to the document end. */
export function textOffsetToPos(doc: PMNode, offset: number): number {
  let remaining = Math.max(0, offset);
  let result = -1;
  doc.forEach((child, childOffset) => {
    if (result !== -1) return;
    const textLen = child.content.size;
    if (remaining <= textLen) {
      // Text inside a paragraph starts one position after its opening tag.
      result = childOffset + 1 + remaining;
      return;
    }
    remaining -= textLen + 1; // +1 for the '\n' between paragraphs
  });
  // Past the end: the last text position is one before the doc's closing tag.
  return result === -1 ? doc.content.size - 1 : result;
}

/** Map a PM position back to a char offset in the serialized text. Positions
 *  outside any paragraph's text (node boundaries) clamp to the nearest text
 *  offset. */
export function posToTextOffset(doc: PMNode, pos: number): number {
  let offset = 0;
  let result = -1;
  doc.forEach((child, childOffset) => {
    if (result !== -1) return;
    const textLen = child.content.size;
    const textStart = childOffset + 1;
    const textEnd = textStart + textLen;
    if (pos <= textEnd) {
      result = offset + Math.max(0, pos - textStart);
      return;
    }
    offset += textLen + 1; // +1 for the '\n' between paragraphs
  });
  return result === -1 ? offset : result;
}

/** clipboardTextParser for the composer: split on SINGLE newlines (the doc
 *  model is one paragraph per line) so consecutive blank lines survive —
 *  PM's default parser splits on /\n+/, silently dropping them. \r\n is
 *  normalized first. Slice.maxOpen lets a paste merge with the paragraph it
 *  lands in. */
export function parseClipboardText(text: string): Slice {
  return Slice.maxOpen(textToDoc(text.replace(/\r\n?/g, '\n')).content);
}

/** clipboardTextSerializer for the composer: paragraphs are lines, so join
 *  with SINGLE newlines — PM's default textBetween separator is "\n\n", which
 *  would double every line break on copy. */
export function serializeClipboardSlice(slice: Slice): string {
  const lines: string[] = [];
  slice.content.forEach((node) => {
    lines.push(node.textContent);
  });
  return lines.join('\n');
}
