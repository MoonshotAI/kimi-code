import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decode } from '@toon-format/toon';
import type { Locator, Page } from '@playwright/test';

import { BROWSER_AUTOMATION_PROTOCOL } from '../../src/shared/browser-automation';
import { expect, test as base, type DesktopApp } from './app';
import { call, textOf, type ModelRequest, type Step, type StubModel } from './model';

export const BROWSER_TOOL = 'mcp__desktop_browser__run';

export interface Site {
  readonly origin: string;
  readonly url: (path: string) => string;
  readonly hits: (path: string) => number;
}

export interface Sites {
  readonly harbor: Site;
  readonly lab: Site;
}

const STYLE = '<style>html,body{background:#fbfaf6;color:#1d232b;font:16px/1.5 system-ui,sans-serif;margin:0}main{padding:24px 32px}a{color:#0b57d0}</style>';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${STYLE}</head><body><main>${body}</main></body></html>`;
}

function harborPages(lab: () => string): Record<string, (visit: number) => string> {
  return {
    '/home': () => page('Harbor Home', [
      '<h1>Harbor Home</h1>',
      '<p>The harbor log records every tide, every boat and every tide change.</p>',
      '<p>Check the tide table before you leave: the evening tide is the highest tide this week.</p>',
      '<p><a href="/tides">Read the tide report</a></p>',
      `<p><a href="${lab()}/bench">Visit the lab bench</a></p>`,
    ].join('')),
    '/tides': visit => page('Tide Report', [
      '<h1>Tide Report</h1>',
      `<p id="visit">Report visit ${visit}</p>`,
      '<p>High water at 18:40. Low water at 00:55.</p>',
      '<p><a href="/home">Back to the harbor</a></p>',
      `<p><a href="${lab()}/notes" target="_blank">Open the lab notes in a new tab</a></p>`,
    ].join('')),
    '/departures': () => page('Departures', [
      '<h1>Departures</h1>',
      '<p><a href="/closing" target="_blank">Open the closing notice in a new tab</a></p>',
      '<p><a href="/closing">Read the closing notice here</a></p>',
    ].join('')),
    '/closing': () => page('Closing Notice', [
      '<h1>Closing Notice</h1>',
      '<button type="button" onclick="window.close()">Close this page</button>',
    ].join('')),
  };
}

function labPages(): Record<string, (visit: number) => string> {
  return {
    '/bench': () => page('Lab Bench', [
      '<h1>Lab Bench</h1>',
      '<p>Samples are labelled before they go into the cold room.</p>',
      '<form id="sample" onsubmit="event.preventDefault();document.getElementById(\'saved\').textContent=\'Saved sample: \'+document.getElementById(\'name\').value">',
      '<label for="name">Sample name</label> <input id="name" name="name" autocomplete="off"> <button type="submit">Save sample</button>',
      '</form>',
      '<p id="saved">No sample saved</p>',
      '<p><a href="/notes">Open the lab notes</a></p>',
    ].join('')),
    '/notes': () => page('Lab Notes', [
      '<h1>Lab Notes</h1>',
      '<p>Calibrate the scale every Monday. The centrifuge needs a new seal.</p>',
    ].join('')),
    '/probe': () => page('Permission Probe', [
      '<h1>Permission Probe</h1>',
      '<p>Site data and permissions for this origin.</p>',
    ].join('')),
  };
}

async function serve(routes: () => Record<string, (visit: number) => string>): Promise<{ server: Server; site: Site }> {
  const counts = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const render = routes()[path];
    if (render === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const visit = (counts.get(path) ?? 0) + 1;
    counts.set(path, visit);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(render(visit));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, site: { origin, url: path => `${origin}${path}`, hits: path => counts.get(path) ?? 0 } };
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

export const test = base.extend<{ sites: Sites }>({
  // eslint-disable-next-line no-empty-pattern
  sites: async ({}, use) => {
    const lab = await serve(labPages);
    const harbor = await serve(() => harborPages(() => lab.site.origin));
    await use({ harbor: harbor.site, lab: lab.site });
    await Promise.all([stop(harbor.server), stop(lab.server)]);
  },
});

export { expect };

export const detailPanel = (app: DesktopApp): Locator => app.window.getByRole('complementary', { name: 'Detail panel' });
export const browserSection = (app: DesktopApp): Locator => app.window.getByRole('region', { name: 'Browser' });
export const addressBar = (app: DesktopApp): Locator => app.window.getByRole('combobox', { name: 'Web address' });
export const agentBadge = (dialog: Locator): Locator => dialog.getByRole('note', { name: /^Agent / });

export async function tabLabels(app: DesktopApp): Promise<string[]> {
  return detailPanel(app).getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label') ?? ''));
}

export async function goTo(app: DesktopApp, address: string): Promise<void> {
  const bar = addressBar(app);
  await bar.click();
  await bar.fill(address);
  await bar.press('Enter');
  await bar.blur();
}

export async function chooseOverlayItem(app: DesktopApp, item: string | RegExp, role: 'menuitem' | 'menuitemradio' = 'menuitem'): Promise<void> {
  const overlay = await app.overlay();
  const entry = overlay.getByRole(role, { name: item, exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
}

export async function browserMenu(app: DesktopApp): Promise<Page> {
  await browserSection(app).getByRole('button', { name: 'Browser menu' }).click();
  const overlay = await app.overlay();
  await expect(overlay.getByRole('menu')).toBeVisible();
  return overlay;
}

export function pageAt(app: DesktopApp, url: string): Promise<Page> {
  return app.page(current => current === url, url);
}

export async function stubWebSearch(app: DesktopApp): Promise<void> {
  await app.electron.evaluate(({ session }) => {
    const browser = session.fromPartition('persist:kimi-browser');
    browser.protocol.handle('https', (request) => {
      const query = new URL(request.url).searchParams.get('q') ?? '';
      const html = `<!doctype html><html><head><title>Search: ${query.replace(/[<&]/g, '')}</title><style>html,body{background:#fbfaf6;color:#1d232b;font:16px system-ui}</style></head><body><main><h1>Offline search stub</h1></main></body></html>`;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
  });
}

export async function recordFindResults(app: DesktopApp, url: string): Promise<() => Promise<Array<{ matches: number; active: number }>>> {
  await app.electron.evaluate(({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find(entry => entry.getURL() === target);
    if (contents === undefined) throw new Error(`No web contents at ${target}`);
    const results: Array<{ matches: number; active: number }> = [];
    (globalThis as { __kimiE2eFindResults?: unknown }).__kimiE2eFindResults = results;
    contents.on('found-in-page', (_event, result) => {
      if (result.finalUpdate) results.push({ matches: result.matches, active: result.activeMatchOrdinal });
    });
  }, url);
  return () => app.electron.evaluate(() => [...((globalThis as { __kimiE2eFindResults?: Array<{ matches: number; active: number }> }).__kimiE2eFindResults ?? [])]);
}

export interface BrowserToolResult {
  readonly ok: boolean;
  readonly operation?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly tab?: { readonly tabId: string; readonly url: string };
  readonly elements?: { readonly snapshotId: string; readonly elements: ReadonlyArray<{ readonly ref: string; readonly role: string; readonly name: string }> };
  readonly [key: string]: unknown;
}

export function toolResults(request: ModelRequest): BrowserToolResult[] {
  return request.messages
    .filter(message => message.role === 'tool')
    .map((message) => {
      const text = textOf(message.content);
      const body = text.slice(Math.max(0, text.search(/[{[]|^\w+:/m)));
      try {
        return (body.trimStart().startsWith('{') ? JSON.parse(body) : decode(body)) as BrowserToolResult;
      } catch {
        return { ok: false, raw: text };
      }
    });
}

export function lastToolResult(request: ModelRequest): BrowserToolResult {
  const result = toolResults(request).at(-1);
  if (result === undefined) throw new Error(`Request ${request.index} carries no tool result`);
  return result;
}

export function browse(operation: string, params: Record<string, unknown> = {}, text?: string): Step {
  return call(BROWSER_TOOL, { protocol: BROWSER_AUTOMATION_PROTOCOL, operation, ...params }, text);
}

export function fromLastResult(model: StubModel, build: (previous: BrowserToolResult, request: ModelRequest) => Step, holdName?: string): Step {
  let built: { index: number; step: Step } | undefined;
  const current = (): Step => {
    const request = model.requests().at(-1)!;
    if (built?.index !== request.index) built = { index: request.index, step: build(lastToolResult(request), request) };
    return built.step;
  };
  return {
    get text() { return current().text; },
    get calls() { return current().calls; },
    get finishReason() { return current().finishReason; },
    ...(holdName === undefined ? {} : { hold: { name: holdName, afterChunks: 0 } }),
  };
}
