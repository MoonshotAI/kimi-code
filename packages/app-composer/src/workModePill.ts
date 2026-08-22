// packages/app-composer/src/workModePill.ts
// The work-mode pill (plan / goal armed intent) and the empty-doc placeholder
// as ProseMirror WIDGET DECORATIONS — elements inside the contentEditable that
// are NOT document content. That one choice carries the whole contract:
//   - head-only: the decorations are built at position 1 (the first
//     paragraph's first inline position) on every state, so the pill can never
//     sit mid-document, and the pill widget's negative `side` keeps a cursor /
//     inserted content AFTER it — no paste can push it off the head.
//   - not text: decorations are invisible to the doc, so the serialized text
//     (docToText / clipboard), the char-offset mapping, and the undo stack are
//     untouched by construction — the pill never mixes into the wire format.
//   - layout: in-flow, the pill shares the first line like an inline chip and
//     scrolls with the document — no overlay, no measured text-indent reserve.
// The DOM builders live here (editor-only); the plugin wiring lives in
// composerEditor.ts. Styling lives in the app's Composer styles (.wm-pill
// etc., scoped-deep) — same split as the mention pill (app-ui global rules).
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { iconSvg } from './icons';

export type WorkModeKind = 'plan' | 'goal';

/** Everything the pill renders, already localized by the caller. */
export interface WorkModePillSpec {
  mode: WorkModeKind;
  /** The mode's visible label (Plan / Goal). */
  label: string;
  /** aria-label + tooltip of the dismiss ×. */
  dismissLabel: string;
}

/** The editor state the decoration layer renders. */
export interface ComposerDecoState {
  /** The armed work mode, or null for no pill. */
  pill: WorkModePillSpec | null;
  /** The placeholder line shown while the doc is empty ('' shows nothing). */
  placeholder: string;
}

/** The pill's × is a plain <button> hand-built to the IconButton contract
 *  (same geometry/hover/focus tokens — the mentionTooltip buttons set the
 *  precedent): Vue primitives can't reach widget-decoration DOM. */
export function buildWorkModePill(spec: WorkModePillSpec, onDismiss: () => void): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'wm-pill';
  pill.dataset.workMode = spec.mode;
  const icon = document.createElement('span');
  icon.className = 'wm-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconSvg(spec.mode === 'goal' ? 'target' : 'file-edit', 'sm');
  const label = document.createElement('span');
  label.textContent = spec.label;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'wm-x';
  dismiss.setAttribute('aria-label', spec.dismissLabel);
  dismiss.title = spec.dismissLabel;
  dismiss.innerHTML = iconSvg('close', 'sm');
  // mousedown is swallowed so the editor never takes focus or starts a
  // selection from the ×; the click itself does the disarm.
  dismiss.addEventListener('mousedown', (event) => event.preventDefault());
  dismiss.addEventListener('click', () => onDismiss());
  pill.append(icon, label, dismiss);
  return pill;
}

/** The empty-doc placeholder as a plain muted span (the textarea's native
 *  placeholder has no analogue inside a contenteditable). Purely visual: the
 *  same text already names the editor via the root's aria-label, so the span
 *  is hidden from the accessibility tree — a visible placeholder must not
 *  read as the field's VALUE (the old ::before overlay never entered it). */
export function buildComposerPlaceholder(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'wm-placeholder';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = text;
  return span;
}

/** True when the doc holds no user content (one empty paragraph). */
function isEmptyDoc(doc: PMNode): boolean {
  return doc.childCount === 1 && doc.firstChild!.content.size === 0;
}

/** The composer chrome decorations for a doc state: the armed work-mode pill
 *  and/or the placeholder, both pinned to position 1 — the head of the first
 *  paragraph. Returns null when there is nothing to draw (the common
 *  no-pill, non-empty case), so the plugin can skip a DecorationSet rebuild.
 *
 *  Side discipline at the shared position: the pill's side is negative, so it
 *  draws BEFORE a cursor at position 1 and content inserted there lands after
 *  it (typing/pasting can never precede the pill); the placeholder's side is
 *  non-negative, so it draws after the cursor — the caret blinks at the text
 *  column, overlapping the placeholder's first glyph like a native
 *  placeholder. Lower side draws first, so pill → placeholder → text.
 *
 *  Widget keys carry the rendered content: a spec/label change produces a new
 *  key, which is what makes PM tear the old DOM down and rebuild it. */
export function buildComposerDecorations(doc: PMNode, state: ComposerDecoState, onDismiss: () => void): DecorationSet | null {
  const decorations: Decoration[] = [];
  if (state.pill) {
    const spec = state.pill;
    decorations.push(
      Decoration.widget(1, () => buildWorkModePill(spec, onDismiss), {
        side: -1,
        key: `workmode-pill-${spec.mode}-${spec.label}-${spec.dismissLabel}`,
        ignoreSelection: true,
        // Events inside the pill are the × button's own; PM must not turn
        // them into selection/caret moves.
        stopEvent: () => true,
      }),
    );
  }
  if (state.placeholder && isEmptyDoc(doc)) {
    decorations.push(
      Decoration.widget(1, () => buildComposerPlaceholder(state.placeholder), {
        side: 0,
        key: `composer-placeholder-${state.placeholder}`,
        ignoreSelection: true,
      }),
    );
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : null;
}
