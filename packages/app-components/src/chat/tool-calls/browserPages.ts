export function browserPageKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') return undefined;
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

const QUERY_LIMIT = 48;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function readableBrowserUrl(key: string): string {
  let url: URL;
  try {
    url = new URL(key);
  } catch {
    return key;
  }
  const path = url.pathname === '/' ? '' : decoded(url.pathname);
  const query = decoded(url.search);
  return `${url.protocol === 'file:' ? '' : url.host}${path}${query.length <= QUERY_LIMIT ? query : ''}`;
}

export function browserPageHost(key: string): string {
  try {
    return new URL(key).host;
  } catch {
    return '';
  }
}

interface TabPage {
  url: string;
  title: string | undefined;
  staleTitle: string | undefined;
  lagging: boolean;
}

export class BrowserPageTracker {
  private readonly tabs = new Map<string, TabPage>();
  private readonly titles = new Map<string, string>();
  private readonly names = new Map<string, string>();

  observe(tabId: string, url: string, title: string | undefined, via?: string): void {
    const previous = this.tabs.get(tabId);
    const moved = previous !== undefined && previous.url !== url;
    const staleTitle = moved ? previous.title ?? previous.staleTitle : previous?.staleTitle;
    const shown = title?.trim() || undefined;
    const carried = shown !== undefined && shown === staleTitle;
    const trusted = shown !== undefined && !carried && !(moved && previous.lagging) ? shown : undefined;
    if (trusted !== undefined) this.titles.set(url, trusted);
    const name = via?.trim();
    if (moved && name && !this.names.has(url)) this.names.set(url, name);
    this.tabs.set(tabId, {
      url,
      title: trusted ?? (moved ? undefined : previous?.title),
      staleTitle: trusted === undefined ? shown ?? staleTitle : staleTitle,
      lagging: shown === undefined ? previous?.lagging ?? false : trusted === undefined,
    });
  }

  seed(tabId: string, url: string, title: string | undefined): void {
    if (!this.tabs.has(tabId)) this.tabs.set(tabId, { url, title: title?.trim() || undefined, staleTitle: undefined, lagging: false });
  }

  current(tabId: string): string | undefined {
    return this.tabs.get(tabId)?.url;
  }

  label(url: string): string | undefined {
    return this.titles.get(url) ?? this.names.get(url);
  }
}
