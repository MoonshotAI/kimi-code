import type { BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import type { BrowserReferenceAttrs } from '../../model/wireCodec';
import { truncateGraphemes } from '../../model/graphemes';
import { iconSvg } from '../../shared/icons';

export function renderBrowserReferencePill(pill: HTMLElement, attrs: BrowserReferenceAttrs, reference?: BrowserReference): void {
  pill.className = 'quote-pill browser-reference-pill';
  pill.dataset.browserRefId = attrs.refId;
  pill.setAttribute('role', 'button');
  pill.tabIndex = 0;
  pill.setAttribute('aria-label', reference?.comment ? `${attrs.label}\n${reference.comment}` : attrs.label);
  const icon = document.createElement('span');
  icon.className = 'quote-pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = iconSvg('browser', 'sm');
  const label = document.createElement('span');
  label.className = 'quote-pill-name';
  label.textContent = truncateGraphemes(attrs.label, 32);
  pill.replaceChildren(icon, label);
  if (reference?.comment) {
    const comment = document.createElement('span');
    comment.className = 'quote-pill-comment';
    comment.textContent = truncateGraphemes(reference.comment, 32);
    pill.append(comment);
  }
}
