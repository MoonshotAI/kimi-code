import type { MentionAttrs } from '../../model';
import { splitGraphemes, truncateGraphemes } from '../../model/graphemes';
import { mentionIconSvg } from './icons';

export { truncateGraphemes } from '../../model/graphemes';

export const MENTION_NAME_MAX = 32;

export function truncateMentionNameTo(name: string, cap: number): string {
  const chars = splitGraphemes(name);
  if (chars.length <= cap) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? splitGraphemes(name.slice(dot)) : [];

  const tail = ext.length + 4;
  const head = cap - 1 - tail;
  if (head < 2) {
    return truncateGraphemes(name, cap);
  }
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

export function truncateMentionName(name: string): string {
  return truncateMentionNameTo(name, MENTION_NAME_MAX);
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
