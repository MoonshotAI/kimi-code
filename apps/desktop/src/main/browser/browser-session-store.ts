import { randomUUID } from 'node:crypto';
import { log } from '../diagnostics/log';
import { asBrowserFavicon } from '../../shared/browser';
import { isBrowserZoomFactor } from '../../shared/browser-zoom';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserPanelSession } from '@moonshot-ai/app-core/browser-panel-state';
import { asBrowserPanelSessions } from '../../shared/browser-panel-state';

export interface SavedBrowserPage {
  url: string;
  title: string;
  zoomFactor: number;
  muted?: boolean;
  favicon?: string;
}

export interface BrowserPagePersistence {
  flush(): void;
  setDefaultZoom(factor: number): void;
  getPage(browserId: string): SavedBrowserPage | undefined;
  savePage(browserId: string, page: SavedBrowserPage): void;
  deletePage(browserId: string): void;
}

export function isRestorableBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024 * 1024) return false;
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:';
  } catch {
    return false;
  }
}

export class BrowserSessionStore implements BrowserPagePersistence {
  private layouts: BrowserPanelSession[] = [];
  private pages: Record<string, SavedBrowserPage> = Object.create(null);

  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly file: string) {
    try { this.load(); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      renameSync(file, `${file}.invalid-${randomUUID()}`);
      this.layouts = [];
      this.pages = Object.create(null);
      log.warn('[kimi-desktop] invalid browser session state was preserved separately');
    }
  }

  private load(): void {
    let contents: string;
    try {
      contents = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed: unknown = JSON.parse(contents);
    if (parsed === null || typeof parsed !== 'object') throw new SyntaxError('Invalid browser session state');
    const state = parsed as Record<string, unknown>;
    const layouts = asBrowserPanelSessions(state['sessions']);
    if (layouts === null || state['version'] !== 1) throw new SyntaxError('Invalid browser session state');
    this.layouts = layouts;
    const pages = state['pages'];
    if (pages === null || typeof pages !== 'object') return;
    for (const browserId of layouts.flatMap(session => session.tabs.map(tab => tab.browserId))) {
      const page = (pages as Record<string, SavedBrowserPage>)[browserId];
      if (page === undefined || page === null || typeof page !== 'object' || !isRestorableBrowserUrl(page.url)) continue;
      this.pages[browserId] = {
        url: page.url,
        ...(asBrowserFavicon(page.favicon) === null ? {} : { favicon: page.favicon }),
        ...(typeof page.muted === 'boolean' ? { muted: page.muted } : {}),
        title: typeof page.title === 'string' ? page.title.slice(0, 512) : '',
        zoomFactor: isBrowserZoomFactor(page.zoomFactor) ? page.zoomFactor : 1,
      };
    }
  }

  getSessions(): BrowserPanelSession[] {
    return structuredClone(this.layouts);
  }

  saveSessions(sessions: BrowserPanelSession[]): void {
    const parsed = asBrowserPanelSessions(sessions);
    if (parsed === null) throw new Error('Invalid browser panel sessions');
    if (JSON.stringify(parsed) === JSON.stringify(this.layouts)) return;
    this.layouts = parsed;
    this.scheduleWrite();
  }

  getPage(browserId: string): SavedBrowserPage | undefined {
    const page = this.pages[browserId];
    if (page !== undefined) return { ...page };
    const tab = this.layouts.flatMap(session => session.tabs).find(tab => tab.browserId === browserId);
    return tab === undefined ? undefined : { url: '', title: tab.title ?? '', zoomFactor: 1 };
  }

  savePage(browserId: string, page: SavedBrowserPage): void {
    if (!isRestorableBrowserUrl(page.url)) return;
    const next = { ...(asBrowserFavicon(page.favicon) === null ? {} : { favicon: page.favicon }), url: page.url, title: page.title.slice(0, 512), zoomFactor: page.zoomFactor, ...(page.muted === undefined ? {} : { muted: page.muted }) };
    if (JSON.stringify(this.pages[browserId]) === JSON.stringify(next)) return;
    this.pages[browserId] = next;
    this.scheduleWrite();
  }

  deletePage(browserId: string): void {
    const layouts = this.layouts.flatMap(session => {
      const tabs = session.tabs.filter(tab => tab.browserId !== browserId);
      if (tabs.length === 0) return [];
      const activeBrowserId = session.activeBrowserId === browserId ? null : session.activeBrowserId;
      return [{ ...session, tabs, activeBrowserId }];
    });
    if (this.pages[browserId] === undefined && JSON.stringify(layouts) === JSON.stringify(this.layouts)) return;
    delete this.pages[browserId];
    this.layouts = layouts;
    this.flush();
  }

  setDefaultZoom(factor: number): void {
    const ids = new Set([...Object.keys(this.pages), ...this.layouts.flatMap(session => session.tabs.map(tab => tab.browserId))]);
    for (const id of ids) {
      const page = this.getPage(id);
      if (page !== undefined) this.savePage(id, { ...page, zoomFactor: factor });
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== undefined) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      try { this.flush(); } catch (error) { log.error('[kimi-desktop] failed to persist browser sessions', error); }
    }, 250);
    this.writeTimer.unref?.();
  }

  flush(): void {
    clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions: this.layouts, pages: this.pages }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
