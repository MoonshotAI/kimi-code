// packages/app-composer/src/quotePill.ts
// The quote-pill DOM builder (selection quote actions — 划词). Same contract
// as attachmentPill.ts: the composer's ProseMirror NodeView builds through
// this, the full quote rides in data-quote-text for the mentionTooltip
// singleton, and styling lives in app-ui's global .quote-pill rules (next to
// .mention-pill / .attachment-pill). No native `title`: hover is owned by the
// mentionTooltip singleton.
//
// a11y: the aria-label carries the FULL quote — that is the keyboard/screen-
// reader reachable layer TODAY (an atom's truncated label would otherwise be
// all an SR user gets). Moving keyboard focus INTO the tooltip's copy button
// is a FAMILY-LEVEL gap shared by every pill kind (mention / attachment /
// quote — the mentionTooltip singleton owns no focus management for its
// bubble), tracked as a follow-up rather than patched per-kind here.
import type { QuoteAttrs } from './composerTextDoc';
import { quotePillLabel } from './composerTextDoc';
import { iconSvg } from './icons';

/** Raw SVG string for the quote pill's leading glyph (Remix chat-quote-line),
 *  also the quote tooltip's leading glyph. */
export function quoteIconSvg(): string {
  return iconSvg('quote', 'sm');
}

export function buildQuotePill(attrs: QuoteAttrs): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'quote-pill';
  pill.dataset.quoteText = attrs.text;
  if (attrs.source !== undefined && attrs.source.length > 0) pill.dataset.quoteSource = attrs.source;
  // The full quote is the keyboard/screen-reader reachable layer — the
  // visible label is truncated, the hover tooltip is mouse-only.
  pill.setAttribute('aria-label', attrs.comment !== undefined && attrs.comment.length > 0 ? `${attrs.text}\n${attrs.comment}` : attrs.text);
  const icon = document.createElement('span');
  icon.className = 'quote-pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = quoteIconSvg();
  const label = document.createElement('span');
  label.className = 'quote-pill-name';
  label.textContent = quotePillLabel(attrs.text);
  pill.append(icon, label);
  // The bundled comment (评论 flow): a hairline divider and the comment
  // excerpt as the pill's second segment — quote and comment read as ONE
  // annotation, never as pill plus loose text.
  if (attrs.comment !== undefined && attrs.comment.length > 0) {
    pill.dataset.quoteComment = attrs.comment;
    const divider = document.createElement('span');
    divider.className = 'quote-pill-divider';
    divider.setAttribute('aria-hidden', 'true');
    const comment = document.createElement('span');
    comment.className = 'quote-pill-comment';
    comment.textContent = quotePillLabel(attrs.comment);
    pill.append(divider, comment);
  }
  return pill;
}
