import type { Node as PMNode } from 'prosemirror-model';
import { placeholderHtml } from '@moonshot-ai/app-core/lib';

export interface ComposerPlaceholderRect {
  left: number;
  top: number;
}

export interface ComposerPlaceholderBox extends ComposerPlaceholderRect {
  right: number;
  bottom: number;
}

export interface ComposerPlaceholderLayout {
  left: number;
  top: number;
  maxWidth: number;
}

export function composerPlaceholderAnchor(
  paragraph: ComposerPlaceholderRect,
  prefix?: ComposerPlaceholderBox,
  style?: { lane: 'inline' | 'block'; marginRight: number; marginBottom: number },
): ComposerPlaceholderRect {
  if (!prefix || !style) return { left: paragraph.left, top: paragraph.top };
  if (style.lane === 'inline') {
    return { left: prefix.right + style.marginRight, top: paragraph.top };
  }
  return { left: paragraph.left, top: prefix.bottom + style.marginBottom };
}

export function commandArgumentPlaceholderAnchor(
  caret: ComposerPlaceholderBox,
  lineHeight: number,
): ComposerPlaceholderRect {
  const caretHeight = caret.bottom - caret.top;
  if (!Number.isFinite(lineHeight) || lineHeight <= caretHeight) {
    return { left: caret.left, top: caret.top };
  }
  return { left: caret.left, top: caret.top - (lineHeight - caretHeight) / 2 };
}

export function isEmptyComposerDoc(doc: PMNode): boolean {
  return doc.childCount === 1 && doc.firstChild!.content.size === 0;
}

export function buildComposerPlaceholderOverlay(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'composer-placeholder-overlay';
  span.setAttribute('aria-hidden', 'true');
  span.hidden = true;
  span.innerHTML = placeholderHtml(text);
  return span;
}

export function setComposerPlaceholderOverlayText(element: HTMLElement, text: string): void {
  element.innerHTML = placeholderHtml(text);
}

export function composerPlaceholderLayout(
  anchor: ComposerPlaceholderRect,
  host: ComposerPlaceholderRect,
  scroll: { left: number; top: number },
  clientWidth: number,
): ComposerPlaceholderLayout {
  const left = anchor.left - host.left + scroll.left;
  const top = anchor.top - host.top + scroll.top;
  return {
    left,
    top,
    maxWidth: Math.max(0, scroll.left + clientWidth - left),
  };
}
