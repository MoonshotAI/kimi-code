import { NodeSelection, TextSelection } from 'prosemirror-state';
import { type EditorView } from 'prosemirror-view';
import { redo, undo } from 'prosemirror-history';
import type { ComposerEditorApi } from './contracts';
import { updatePastedTextPill } from '../features/pasted-text/edit';

const viewByDom = new WeakMap<HTMLElement, EditorView>();

export function registerComposerEditorView(dom: HTMLElement, view: EditorView): void {
  viewByDom.set(dom, view);
}

const liveEditorBySession = new Map<string, { api: ComposerEditorApi; token: unknown }>();

export function registerLiveComposerEditor(sessionId: string, api: ComposerEditorApi): () => void {
  const token = {};
  liveEditorBySession.set(sessionId, { api, token });
  return () => {
    if (liveEditorBySession.get(sessionId)?.token === token) {
      liveEditorBySession.delete(sessionId);
    }
  };
}

export function liveComposerEditorFor(sessionId: string): ComposerEditorApi | undefined {
  return liveEditorBySession.get(sessionId)?.api;
}

const attachmentEntryWatchers = new Set<() => void>();

const composerSelectionWatchers = new Set<() => void>();

export function notifyAttachmentEntryWatchers(): void {
  for (const watcher of attachmentEntryWatchers) watcher();
}

export function watchAttachmentEntries(watcher: () => void): () => void {
  attachmentEntryWatchers.add(watcher);
  return () => {
    attachmentEntryWatchers.delete(watcher);
  };
}

export function watchComposerSelections(watcher: () => void): () => void {
  composerSelectionWatchers.add(watcher);
  return () => {
    composerSelectionWatchers.delete(watcher);
  };
}

export function notifyComposerSelectionWatchers(): void {
  for (const watcher of composerSelectionWatchers) watcher();
}

export function runComposerMenuEdit(dom: HTMLElement, command: 'undo' | 'redo'): boolean {
  const view = viewByDom.get(dom);
  if (!view) return false;
  (command === 'undo' ? undo : redo)(view.state, view.dispatch);
  return true;
}

export function getComposerEditorView(dom: HTMLElement): EditorView | undefined {
  return viewByDom.get(dom);
}

export function dismissComposerNodeSelection(dom: HTMLElement): boolean {
  const view = viewByDom.get(dom);
  if (!view || !(view.state.selection instanceof NodeSelection)) return false;
  const selection = TextSelection.near(view.state.doc.resolve(view.state.selection.to), 1);
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();
  return true;
}

export function updateComposerPastedText(pill: HTMLElement, text: string): boolean {
  const dom = pill.closest<HTMLElement>('.ProseMirror');
  const view = dom === null ? undefined : viewByDom.get(dom);
  return view !== undefined && updatePastedTextPill(view, pill, text);
}
