import { pastedTextLineCount, pastedTextPillLabel, type PastedTextAttrs } from '../../model';
import { iconSvg } from '../../shared/icons';

export type PastedTextMeta = (lineCount: number) => string;

export function pastedTextIconSvg(): string {
  return iconSvg('text', 'sm');
}

export function buildPastedTextPill(attrs: PastedTextAttrs, meta?: PastedTextMeta): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'quote-pill pasted-text-pill';
  pill.dataset.pastedText = attrs.text;
  const label = pastedTextPillLabel(attrs.text);
  const metaText = meta?.(pastedTextLineCount(attrs.text));
  pill.setAttribute('aria-label', metaText === undefined ? label : `${label} · ${metaText}`);
  const icon = document.createElement('span');
  icon.className = 'quote-pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = pastedTextIconSvg();
  const name = document.createElement('span');
  name.className = 'quote-pill-name';
  name.textContent = label;
  pill.append(icon, name);
  if (metaText !== undefined) {
    const detail = document.createElement('span');
    detail.className = 'quote-pill-comment';
    detail.textContent = metaText;
    pill.append(detail);
  }
  return pill;
}
