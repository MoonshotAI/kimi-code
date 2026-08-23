// packages/app-composer/src/attachmentPill.ts
// The single attachment-pill DOM builder — the composer's ProseMirror
// NodeView and the message-side renderer (ComposerText) share the same
// structure (classes + data-attachment-* attributes), so a pill looks
// identical in the editor and the message stream, and the mentionTooltip
// singleton can read its identity from the attributes alone. Styling lives
// in app-ui's global .attachment-pill rules (next to .mention-pill). No
// native `title`: hover is owned by the mentionTooltip singleton.
import type { AttachmentAttrs } from './composerTextDoc';
import { iconSvg } from './icons';
import { truncateMentionName } from './mentionPill';

/** Raw SVG string for the attachment pill's leading glyph — the paperclip
 *  (Remix attachment-2), the attachment content type's single icon. */
export function attachmentIconSvg(): string {
  return iconSvg('attachment', 'sm');
}

export function buildAttachmentPill(attrs: AttachmentAttrs): HTMLElement {
  const pill = document.createElement('span');
  pill.className = `attachment-pill attachment-${attrs.kind}`;
  pill.dataset.attachmentId = attrs.attId;
  pill.dataset.attachmentKind = attrs.kind;
  pill.dataset.attachmentName = attrs.name;
  const icon = document.createElement('span');
  icon.className = 'attachment-pill-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = attachmentIconSvg();
  const label = document.createElement('span');
  label.className = 'attachment-pill-name';
  label.textContent = truncateMentionName(attrs.name);
  pill.append(icon, label);
  return pill;
}
