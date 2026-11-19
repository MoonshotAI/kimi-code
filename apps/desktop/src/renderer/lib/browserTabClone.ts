import type { BrowserTabPayload } from '@moonshot-ai/app-client/panel';
import type { BrowserId, BrowserState } from '../../shared/browser';

export function clonedBrowserTabPayload(
  source: BrowserTabPayload,
  browserId: BrowserId,
  state: Pick<BrowserState, 'title' | 'favicon'>,
): BrowserTabPayload {
  return {
    browserId,
    title: state.title || source.title,
    customTitle: source.customTitle,
    favicon: state.favicon ?? source.favicon,
  };
}
