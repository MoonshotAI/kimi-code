import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { composerSchema } from './schema';
import { serializeAttachment, serializeMention, serializeQuote, type AttachmentAttrs, type MentionAttrs, type QuoteAttrs } from './wireCodec';
import { serializeBrowserReference, serializePastedText, type BrowserReferenceAttrs, type PastedTextAttrs } from './wireCodec';
function inlineSerializedLength(node: PMNode): number {
  if (node.isText) return node.text!.length;
  if (node.type === composerSchema.nodes.browser_reference) return serializeBrowserReference(node.attrs as BrowserReferenceAttrs).length;
  if (node.type === composerSchema.nodes.attachment) return serializeAttachment(node.attrs as AttachmentAttrs).length;
  if (node.type === composerSchema.nodes.quote) return serializeQuote(node.attrs as QuoteAttrs).length;
  if (node.type === composerSchema.nodes.pasted_text) return serializePastedText(node.attrs as PastedTextAttrs).length;
  return serializeMention(node.attrs as MentionAttrs).length;
}

export function inlineRunStartOffset(doc: PMNode, $pos: ResolvedPos): number {
  if (!$pos.parent.isTextblock) return posToTextOffset(doc, $pos.pos);
  if ($pos.textOffset > 0) {
    return posToTextOffset(doc, $pos.pos - $pos.textOffset);
  }
  const before = $pos.nodeBefore;
  if (before && before.isText) {
    return posToTextOffset(doc, $pos.pos - before.nodeSize);
  }
  return posToTextOffset(doc, $pos.pos);
}

export function textOffsetToPos(doc: PMNode, offset: number): number {
  let remaining = Math.max(0, offset);
  let result = -1;
  doc.forEach((para, paraStart) => {
    if (result !== -1) return;
    let paraSerLen = 0;
    para.forEach((child) => {
      paraSerLen += inlineSerializedLength(child);
    });
    if (remaining > paraSerLen) {
      remaining -= paraSerLen + 1;
      return;
    }
    para.forEach((child, childOffset) => {
      if (result !== -1) return;
      const childPos = paraStart + 1 + childOffset;
      const len = inlineSerializedLength(child);
      if (remaining <= len) {
        if (child.isText) {
          result = childPos + remaining;
        } else {
          result = remaining === 0 ? childPos : childPos + 1;
        }
        return;
      }
      remaining -= len;
    });
    if (result === -1) result = paraStart + 1 + para.content.size;
  });
  return result === -1 ? doc.content.size - 1 : result;
}

export function posToTextOffset(doc: PMNode, pos: number): number {
  let offset = 0;
  let result = -1;
  doc.forEach((para, paraStart) => {
    if (result !== -1) return;
    const paraEnd = paraStart + para.nodeSize;
    if (pos > paraEnd) {
      para.forEach((child) => {
        offset += inlineSerializedLength(child);
      });
      offset += 1;
      return;
    }
    let inlineOffset = 0;
    para.forEach((child, childOffset) => {
      if (result !== -1) return;
      const childPos = paraStart + 1 + childOffset;
      if (child.isText) {
        const childEnd = childPos + child.nodeSize;
        if (pos <= childEnd) {
          result = offset + inlineOffset + Math.max(0, pos - childPos);
          return;
        }
        inlineOffset += child.text!.length;
      } else {
        const atomEnd = childPos + 1;
        if (pos <= atomEnd) {
          result = offset + inlineOffset + (pos <= childPos ? 0 : inlineSerializedLength(child));
          return;
        }
        inlineOffset += inlineSerializedLength(child);
      }
    });
    if (result === -1) result = offset + inlineOffset;
  });
  return result === -1 ? offset : result;
}

export interface SkillMentionRef {
  name: string;
  path?: string;
}

export function collectSkillMentions(doc: PMNode): SkillMentionRef[] {
  const refs: SkillMentionRef[] = [];
  doc.forEach((para) => {
    para.forEach((child) => {
      if (!child.isText && child.type === composerSchema.nodes.mention && child.attrs.kind === 'skill') {
        refs.push({
          name: child.attrs.name as string,
          path: child.attrs.path as string,
        });
      }
    });
  });
  return refs;
}

export function extendToTextblock(start: boolean) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const $head = state.selection.$head;
    const pos = start ? $head.start() : $head.end();
    if (!dispatch) return true;
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, state.selection.$anchor.pos, pos)).scrollIntoView());
    return true;
  };
}
