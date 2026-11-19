export const BROWSER_LINK_CLICK_MAX_AGE_MS = 5000;
export const BROWSER_LINK_CLICK_QUERY_TIMEOUT_MS = 1000;

export function browserLinkClickTrackingScript(): string {
  return String.raw`(() => {
    if (globalThis.__kimiBrowserLinkClick) return;
    const state = globalThis.__kimiBrowserLinkClick = { last: null };
    const linkUrl = node => {
      if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) return node.href || null;
      if (!(node instanceof SVGAElement)) return null;
      const value = node.href.baseVal || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!value) return null;
      try { return new URL(value, node.baseURI).href; } catch { return null; }
    };
    const record = event => {
      let url = null;
      for (const node of event.composedPath()) if ((url = linkUrl(node)) !== null) break;
      state.last = event.isTrusted && event.button !== 2 && url !== null ? { url, at: Date.now() } : null;
    };
    addEventListener('click', record, true);
    addEventListener('auxclick', record, true);
  })()`;
}

export function browserLinkClickedScript(url: string): string {
  return String.raw`(() => {
    const state = globalThis.__kimiBrowserLinkClick;
    const last = state?.last;
    if (state) state.last = null;
    return last != null && last.url === ${JSON.stringify(url)} && Date.now() - last.at < ${BROWSER_LINK_CLICK_MAX_AGE_MS};
  })()`;
}
