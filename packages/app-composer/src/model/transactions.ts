import type { Node as PMNode } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { docToText } from './documentCodec';
import { attachmentNode, composerSchema, mentionNode, quoteNode } from './schema';
import { posToTextOffset, textOffsetToPos } from './positionMapping';
import type { AttachmentAttrs, MentionAttrs, QuoteAttrs } from './wireCodec';
export function buildMentionInsertion(
  state: EditorState,
  attrs: MentionAttrs,
  range: { start: number; end: number },
): Transaction {
  const from = textOffsetToPos(state.doc, range.start);
  const to = textOffsetToPos(state.doc, range.end);
  const text = docToText(state.doc);
  const beforeChar = range.start > 0 ? text.charAt(range.start - 1) : '';
  const afterChar = text.charAt(range.end);
  const nodes: PMNode[] = [];
  if (beforeChar === '!' || beforeChar === '\\') nodes.push(composerSchema.text(' '));
  nodes.push(mentionNode(attrs));
  if (afterChar === '' || !/\s/.test(afterChar)) nodes.push(composerSchema.text(' '));
  const tr = state.tr.replaceWith(from, to, nodes);
  tr.setSelection(TextSelection.create(tr.doc, from + nodes.reduce((size, node) => size + node.nodeSize, 0)));
  return tr.scrollIntoView();
}

export function buildTextRangeReplacement(state: EditorState, text: string, range: { start: number; end: number }): Transaction {
  const from = textOffsetToPos(state.doc, range.start);
  const to = textOffsetToPos(state.doc, range.end);
  const tr = state.tr.insertText(text, from, to);
  tr.setSelection(TextSelection.create(tr.doc, from + text.length));
  return closeHistory(tr.scrollIntoView());
}

export function buildAttachmentInsertion(
  state: EditorState,
  attrs: AttachmentAttrs,
  range?: { start: number; end: number },
): Transaction {
  const start = range ? range.start : posToTextOffset(state.doc, state.selection.from);
  const end = range ? range.end : posToTextOffset(state.doc, state.selection.to);
  const from = textOffsetToPos(state.doc, start);
  const to = textOffsetToPos(state.doc, end);
  const text = docToText(state.doc);
  const beforeChar = start > 0 ? text.charAt(start - 1) : '';
  const afterChar = text.charAt(end);
  const nodes: PMNode[] = [];
  if (beforeChar === '!' || beforeChar === '\\') nodes.push(composerSchema.text(' '));
  nodes.push(attachmentNode(attrs));
  if (afterChar === '' || !/\s/.test(afterChar)) nodes.push(composerSchema.text(' '));
  const tr = state.tr.replaceWith(from, to, nodes);
  tr.setSelection(TextSelection.create(tr.doc, from + nodes.reduce((size, node) => size + node.nodeSize, 0)));
  return tr.scrollIntoView();
}

export function buildAttachmentWithTextInsertion(
  state: EditorState,
  attrs: AttachmentAttrs,
  text: string,
  pos?: number,
): Transaction {
  const range = pos === undefined ? undefined : { start: pos, end: pos };
  return buildAttachmentInsertion(state, text.length > 0 ? { ...attrs, comment: text } : attrs, range);
}

export function buildQuoteInsertion(state: EditorState, attrs: QuoteAttrs, comment?: string): Transaction {
  const pos = state.selection.to;
  const text = docToText(state.doc);
  const textOffset = posToTextOffset(state.doc, pos);
  const beforeChar = textOffset > 0 ? text.charAt(textOffset - 1) : '';
  const afterChar = text.charAt(textOffset);
  const nodes: PMNode[] = [];
  if (beforeChar !== '' && !/\s/.test(beforeChar)) nodes.push(composerSchema.text(' '));
  nodes.push(quoteNode(comment !== undefined && comment.length > 0 ? { ...attrs, comment } : attrs));
  if (afterChar === '' || !/\s/.test(afterChar)) nodes.push(composerSchema.text(' '));
  const tr = state.tr.replaceWith(pos, pos, nodes);
  tr.setSelection(TextSelection.create(tr.doc, pos + nodes.reduce((size, node) => size + node.nodeSize, 0)));
  return tr.scrollIntoView();
}
