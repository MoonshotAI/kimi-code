import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { expect, type Locator, type Page } from '@playwright/test';

import type { DesktopApp } from './app';
import { sidebarOf } from './sessions';

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" rx="8" fill="#1f6feb"/><text x="60" y="38" font-size="20" text-anchor="middle" fill="#fff" font-family="sans-serif">e2e</text></svg>';
const DOCS_HTML = '<!doctype html><html><head><title>Transcript docs fixture</title></head><body><h1>Transcript docs fixture</h1></body></html>';

export interface AssetServer {
  readonly url: (name: string) => string;
  readonly hits: (name: string) => number;
  readonly close: () => Promise<void>;
}

export async function startAssetServer(): Promise<AssetServer> {
  const hits = new Map<string, number>();
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
    hits.set(name, (hits.get(name) ?? 0) + 1);
    if (name === 'logo.svg') response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }).end(LOGO_SVG);
    else if (name === 'docs.html') response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(DOCS_HTML);
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: name => `${origin}/${name}`,
    hits: name => hits.get(name) ?? 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

export async function recordOpenExternal(app: DesktopApp): Promise<() => Promise<string[]>> {
  await app.electron.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __kimiE2eOpenedExternal?: string[] }).__kimiE2eOpenedExternal = opened;
    const guarded = shell.openExternal.bind(shell);
    shell.openExternal = (url, options) => {
      opened.push(url);
      return guarded(url, options);
    };
  });
  return () => app.electron.evaluate(() => [...((globalThis as { __kimiE2eOpenedExternal?: string[] }).__kimiE2eOpenedExternal ?? [])]);
}

export async function recordOpenPath(app: DesktopApp): Promise<() => Promise<string[]>> {
  await app.electron.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __kimiE2eOpenedPaths?: string[] }).__kimiE2eOpenedPaths = opened;
    const guarded = shell.openPath.bind(shell);
    shell.openPath = (path) => {
      opened.push(path);
      return guarded(path);
    };
  });
  return () => app.electron.evaluate(() => [...((globalThis as { __kimiE2eOpenedPaths?: string[] }).__kimiE2eOpenedPaths ?? [])]);
}

export async function waitForScrollRest(transcript: Locator, frames = 10): Promise<void> {
  await transcript.evaluate((element, quietFrames) => new Promise<void>((resolve) => {
    let node: Element | null = element;
    while (node !== null && !['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) node = node.parentElement;
    const target = node ?? document.scrollingElement ?? document.documentElement;
    let last = target.scrollTop;
    let still = 0;
    const tick = (): void => {
      const top = target.scrollTop;
      still = top === last ? still + 1 : 0;
      last = top;
      if (still >= quietFrames) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
}

export async function chooseHeaderMenuItem(app: DesktopApp, item: string): Promise<void> {
  await waitForScrollRest(app.window.getByRole('list').first());
  await app.window.locator('header').getByRole('button', { name: 'Options', exact: true }).click();
  const overlay = await app.overlay();
  const entry = overlay.getByRole('menuitem', { name: item });
  await expect(entry).toBeVisible();
  await entry.click();
}

export async function closeOverlayMenu(app: DesktopApp): Promise<void> {
  const overlay = await app.overlay();
  await overlay.keyboard.press('Escape');
  await expect(overlay.getByRole('menu')).toBeHidden();
}

export function scrollTopOf(transcript: Locator): Promise<number> {
  return transcript.evaluate((element) => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return Math.round(node.scrollTop);
    }
    return -1;
  });
}

export function readZip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('Not a ZIP archive: no end of central directory record');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Corrupt ZIP central directory at ${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, (method === 0 ? data : inflateRawSync(data)).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export function codeBlock(transcript: Locator, language: string): Locator {
  return transcript.locator('div')
    .filter({ has: transcript.page().getByText(language, { exact: true }) })
    .filter({ has: transcript.page().getByRole('code') })
    .last();
}

export async function waitForSettledReply(window: Page, text: string): Promise<void> {
  await expect(window.getByRole('list').first().getByText(text, { exact: true })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
}

export async function relaunchAndSettle(app: DesktopApp, title: string): Promise<void> {
  await app.relaunch();
  await expect(sidebarOf(app).getByText(title, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
}
