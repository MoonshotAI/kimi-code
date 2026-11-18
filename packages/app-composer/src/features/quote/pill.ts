import type { QuoteAttrs } from '../../model';
import { quotePillLabel } from '../../model';
import { iconSvg } from '../../shared/icons';

export function quoteIconSvg(): string {
  return iconSvg('quote', 'sm');
}

export function buildQuotePill(attrs: QuoteAttrs): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'quote-pill';
  pill.dataset.quoteText = attrs.text;
  if (attrs.source !== undefined && attrs.source.length > 0) pill.dataset.quoteSource = attrs.source;
  pill.setAttribute('aria-label', attrs.comment !== undefined && attrs.comment.length > 0 ? `${attrs.text}\n${attrs.comment}` : attrs.text);
  const icon = document.createElement('span');
  icon.className = 'quote-pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = quoteIconSvg();
  const label = document.createElement('span');
  label.className = 'quote-pill-name';
  label.textContent = quotePillLabel(attrs.text);
  pill.append(icon, label);
  if (attrs.comment !== undefined && attrs.comment.length > 0) {
    pill.dataset.quoteComment = attrs.comment;
    const comment = document.createElement('span');
    comment.className = 'quote-pill-comment';
    comment.textContent = quotePillLabel(attrs.comment);
    pill.append(comment);
  }
  return pill;
}
