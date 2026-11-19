import { quotePillLabel, type AttachmentAttrs } from '../../model';
import { iconSvg } from '../../shared/icons';
import { truncateMentionName } from '../mention/pill';

export function attachmentIconSvg(): string {
  return iconSvg('attachment', 'sm');
}

export function attachmentKindIconSvg(kind: string): string {
  if (kind === 'image') return iconSvg('image', 'sm');
  if (kind === 'video') return iconSvg('video', 'sm');
  return attachmentIconSvg();
}

export function buildAttachmentPill(attrs: AttachmentAttrs): HTMLElement {
  const pill = document.createElement('span');
  pill.className = `attachment-pill attachment-${attrs.kind}`;
  pill.dataset.attachmentId = attrs.attId;
  pill.dataset.attachmentKind = attrs.kind;
  pill.dataset.attachmentName = attrs.name;
  if (attrs.kind === 'image' || attrs.kind === 'video') {
    pill.tabIndex = 0;
    pill.setAttribute('aria-haspopup', 'true');
    pill.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }
  const icon = document.createElement('span');
  icon.className = 'attachment-pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = attachmentKindIconSvg(attrs.kind);
  pill.append(icon);
  const label = document.createElement('span');
  label.className = 'attachment-pill-name';
  label.textContent = truncateMentionName(attrs.name);
  pill.append(label);
  if (attrs.comment) {
    pill.dataset.attachmentComment = attrs.comment;
    pill.setAttribute('aria-label', `${attrs.name}\n${attrs.comment}`);
    const comment = document.createElement('span');
    comment.className = 'quote-pill-comment';
    comment.textContent = quotePillLabel(attrs.comment);
    pill.append(comment);
  }
  return pill;
}
