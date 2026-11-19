import type { BrowserCaptureTarget } from '@moonshot-ai/app-core/browser-reference';
import { splitGraphemes, truncateGraphemes } from '../../model/graphemes';

export type BrowserTargetNameKind = 'button' | 'input' | 'image' | 'link' | 'heading' | 'element' | 'region';

export function browserTargetName(target: BrowserCaptureTarget): { kind: BrowserTargetNameKind; name?: string } {
  if (target.kind === 'region') return { kind: 'region' };
  const tag = target.tagName.toLowerCase();
  const role = target.role?.toLowerCase();
  const kind: BrowserTargetNameKind = role === 'button' || tag === 'button'
    ? 'button'
    : role === 'img' || tag === 'img'
      ? 'image'
      : role === 'link' || tag === 'a'
        ? 'link'
        : role === 'heading' || /^h[1-6]$/.test(tag)
          ? 'heading'
          : ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider'].includes(role ?? '') || ['input', 'textarea', 'select'].includes(tag)
            ? 'input'
            : 'element';
  const accessibleName = target.accessibleName?.replace(/\s+/g, ' ').trim();
  if (accessibleName) return { kind, name: truncateGraphemes(accessibleName, 32) };
  const visibleText = target.text?.trim();
  if (visibleText && (kind !== 'element' || ['span', 'p', 'label'].includes(tag)) && !/[\r\n]/.test(visibleText) && splitGraphemes(visibleText).length <= 64) {
    return { kind, name: truncateGraphemes(visibleText.replace(/\s+/g, ' '), 32) };
  }
  return { kind };
}
