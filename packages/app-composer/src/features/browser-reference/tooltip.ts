import type { BrowserCapture, BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import { parseAttachmentThumbnailUrl } from '../attachment/entry';
import { browserCaptureTime } from './time';

export interface BrowserReferenceTooltipInfo {
  label: string;
  reference?: BrowserReference;
  capture?: BrowserCapture;
  thumbnail?: string;
}

const resolvers = new WeakMap<HTMLElement, () => BrowserReferenceTooltipInfo>();

export function setBrowserReferenceTooltip(pill: HTMLElement, resolve: () => BrowserReferenceTooltipInfo): void {
  resolvers.set(pill, resolve);
}

export function browserReferenceTooltip(pill: HTMLElement): HTMLElement {
  const info = resolvers.get(pill)?.() ?? { label: pill.dataset['browserRefLabel'] ?? pill.textContent ?? '' };
  const card = document.createElement('div');
  card.className = 'mention-tip-browser';
  const line = (className: string, value: string | undefined): void => {
    if (!value) return;
    const element = document.createElement('div');
    element.className = className;
    element.textContent = value;
    card.append(element);
  };
  line('mention-tip-name', info.label);
  const capture = info.capture;
  if (capture !== undefined) {
    line('mention-tip-browser-source', capture.page.title);
    line('mention-tip-browser-source', capture.page.url);
    line('mention-tip-browser-source', browserCaptureTime(capture.capturedAt));
    if (capture.target.kind === 'element') line('mention-tip-browser-target', capture.target.locator?.selector ?? capture.target.tagName);
  }
  const thumbnail = parseAttachmentThumbnailUrl(info.thumbnail);
  if (thumbnail !== undefined) {
    const image = document.createElement('img');
    image.className = 'mention-tip-browser-preview';
    image.src = thumbnail;
    image.alt = info.label;
    card.append(image);
  }
  line('mention-tip-browser-comment', info.reference?.comment);
  return card;
}
