/**
 * LocalWebSearchProvider — host-side `WebSearchProvider` without API keys.
 *
 * Searches DuckDuckGo HTML results via POST to html.duckduckgo.com/html/,
 * parses with linkedom (already a dependency via LocalFetchURLProvider).
 * This is the fallback when no Moonshot search API is configured.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DDG_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36';

interface DomElementLike {
  attr(name: string): string | undefined;
  text(): string;
  find(selector: string): DomElementLike;
  each(fn: (i: number, el: DomElementLike) => void): void;
  hasClass(cls: string): boolean;
  length: number;
}

// linkedom doesn't export its types cleanly in non-DOM lib environments.
// We import the module and cast the parse function to return a shape we need.
type ParseHTMLFn = (html: string) => { document: DomElementLike };

async function importLinkedomParse(): Promise<ParseHTMLFn> {
  // linkedom is already a dependency of LocalFetchURLProvider
  const { parseHTML } = await import('linkedom');
  return parseHTML as unknown as ParseHTMLFn;
}

export class LocalWebSearchProvider implements WebSearchProvider {
  private parseHTML: ParseHTMLFn | null = null;

  private async ensureParser(): Promise<ParseHTMLFn> {
    if (this.parseHTML === null) {
      this.parseHTML = await importLinkedomParse();
    }
    return this.parseHTML;
  }

  async search(
    query: string,
    options?: { toolCallId?: string },
  ): Promise<WebSearchResult[]> {
    void options;
    const parseHTML = await this.ensureParser();

    const response = await fetch(DDG_HTML_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': DDG_USER_AGENT,
        Accept: '*/*',
        Host: 'html.duckduckgo.com',
        Connection: 'keep-alive',
      },
      body: new URLSearchParams({ q: query }).toString(),
    });

    if (!response.ok) {
      throw new Error(
        `DuckDuckGo search returned HTTP ${String(response.status)}`,
      );
    }

    const html = await response.text();
    const { document } = parseHTML(html);
    const results: WebSearchResult[] = [];

    const items = document.find('div.result');
    items.each((_, el) => {
      if (results.length >= 10) return;

      const titleEl = el.find('a.result__a');
      const snippetEl = el.find('.result__snippet');
      const title = titleEl.text().trim();
      const url = titleEl.attr('href') ?? '';
      const snippet = snippetEl.text().trim();
      const sourceEl = el.find('.result__url');
      const siteName = sourceEl.text().trim() || undefined;

      if (title.length > 0 && url.length > 0 && !el.hasClass('result--ad')) {
        results.push({
          title,
          url,
          snippet,
          ...(siteName !== undefined ? { siteName } : {}),
        });
      }
    });

    return results;
  }
}
