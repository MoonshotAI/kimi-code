// packages/app-composer/src/mentionPill.ts
// The single mention-pill DOM builder — the composer's ProseMirror NodeView
// and the message-side pillify pass (user bubbles render verbatim text) both
// build through this, so a pill looks identical in the menu, the editor, and
// the message stream. Styling lives in app-ui's global .mention-pill rules.
// No native `title`: hover is owned by the mentionTooltip singleton, which
// reads the data-mention-* attributes set here.
import type { MentionAttrs } from './composerTextDoc';
import { mentionIconSvg } from './mentionIcons';

/** Pill labels cap at this many grapheme clusters (user-perceived chars —
 *  an emoji counts once, however many UTF-16 units it takes); longer names
 *  get a middle ellipsis. */
export const MENTION_NAME_MAX = 32;

/** Built lazily so importing the module stays side-effect-free. */
let graphemeSegmenter: Intl.Segmenter | undefined;

/** Split into grapheme clusters: a cut on these boundaries never slices a
 *  surrogate pair or a ZWJ emoji sequence in half (a UTF-16 slice would
 *  leave a lone surrogate, rendered as `�`). */
function graphemes(text: string): string[] {
  graphemeSegmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' });
  return [...graphemeSegmenter.segment(text)].map((part) => part.segment);
}

/** Middle-ellipsis for an over-long pill label: keep the head of the base
 *  name and the whole extension — the two informative ends of a file name.
 *  The full name stays in the pill's data attributes and the tooltip shows
 *  the complete path, so no information is lost. Pure; node-tested. */
export function truncateMentionName(name: string): string {
  const chars = graphemes(name);
  if (chars.length <= MENTION_NAME_MAX) return name;
  // A '.' is always its own cluster, so the extension split lands on a
  // cluster boundary.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? graphemes(name.slice(dot)) : [];
  // The tail keeps the extension plus a few base-name characters before it.
  const tail = ext.length + 4;
  const head = MENTION_NAME_MAX - 1 - tail;
  if (head < 8) {
    // Pathological extension (e.g. ".d.ts"-plus chains longer than the
    // budget) — plain end-ellipsis is the least-bad fallback.
    return `${chars.slice(0, MENTION_NAME_MAX - 1).join('')}…`;
  }
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

export function buildMentionPill(attrs: MentionAttrs): HTMLElement {
  const pill = document.createElement('span');
  pill.className = `mention-pill mention-${attrs.kind}`;
  pill.dataset.mentionKind = attrs.kind;
  pill.dataset.mentionName = attrs.name;
  if (attrs.path) pill.dataset.mentionPath = attrs.path;
  const icon = document.createElement('span');
  icon.className = 'mention-pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = mentionIconSvg(attrs.kind, attrs.path, attrs.name);
  const label = document.createElement('span');
  label.className = 'mention-pill-name';
  label.textContent = truncateMentionName(attrs.name);
  pill.append(icon, label);
  return pill;
}
