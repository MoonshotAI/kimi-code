import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
export const BROWSER_SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search', parameter: 'q' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search', parameter: 'q' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/', parameter: 'q' },
  baidu: { name: 'Baidu', url: 'https://www.baidu.com/s', parameter: 'wd' },
} as const;

export const BrowserSearchEngineSchema = Type.Enum(Object.keys(BROWSER_SEARCH_ENGINES) as (keyof typeof BROWSER_SEARCH_ENGINES)[]);
export type BrowserSearchEngine = Static<typeof BrowserSearchEngineSchema>;

export function isBrowserSearchEngine(value: unknown): value is BrowserSearchEngine {
  return browserValidators.BrowserSearchEngineSchema.Check(value);
}

export function browserSearchUrl(query: string, engine: BrowserSearchEngine): string {
  const provider = BROWSER_SEARCH_ENGINES[engine];
  const url = new URL(provider.url);
  url.searchParams.set(provider.parameter, query);
  return url.href;
}

export type BrowserAddressKind = 'http' | 'url' | 'domain' | 'search';

export function browserAddressKind(input: string): BrowserAddressKind {
  const localHost = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  const hostPort = /^[\w.-]+:\d+(?:[/?#]|$)/.test(input);
  if (localHost || hostPort) return 'http';
  if (/^https?:/i.test(input) || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(input)) return 'url';
  if (/^[^\s/:]+\.[^\s/:]+(?::\d+)?(?:[/?#]|$)/.test(input)) return 'domain';
  return 'search';
}

export const browserValidators = {
  BrowserSearchEngineSchema: defineBrowserValidator(BrowserSearchEngineSchema),
};
