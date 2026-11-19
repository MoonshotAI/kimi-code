import type { EditorView } from 'prosemirror-view';
import { composerSchema } from '../../model';

export function updatePastedTextPill(view: EditorView, pill: HTMLElement, text: string): boolean {
  let pos: number;
  try {
    pos = view.posAtDOM(pill, 0);
  } catch {
    return false;
  }
  const node = view.state.doc.nodeAt(pos);
  if (node?.type !== composerSchema.nodes.pasted_text) return false;
  const normalized = text.replace(/\r\n?/g, '\n');
  const tr = normalized === ''
    ? view.state.tr.delete(pos, pos + node.nodeSize)
    : view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, text: normalized });
  view.dispatch(tr);
  return true;
}
