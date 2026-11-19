import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

interface Layer {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly png: string;
}

interface Capture {
  readonly width: number;
  readonly height: number;
  readonly layers: Layer[];
  readonly skipped: string[];
}

async function captureLayers(electron: ElectronApplication, auxiliary: RegExp): Promise<Capture> {
  return electron.evaluate(async ({ BaseWindow }, source) => {
    const skip = new RegExp(source);
    const win = BaseWindow.getAllWindows().find((candidate): candidate is Electron.BrowserWindow => {
      const contents = (candidate as Partial<Electron.BrowserWindow>).webContents;
      const url = candidate.isDestroyed() || contents === undefined ? '' : contents.getURL();
      return url.startsWith('app://renderer/') && !skip.test(url);
    });
    if (win === undefined) throw new Error('no main app window to capture');
    const { width, height } = win.getContentBounds();
    const layers: Layer[] = [];
    const skipped: string[] = [];
    const seen = new Set<number>();
    const add = async (contents: Electron.WebContents | undefined, bounds: Electron.Rectangle): Promise<void> => {
      if (contents === undefined || contents.isDestroyed() || seen.has(contents.id)) return;
      seen.add(contents.id);
      contents.invalidate();
      const image = await Promise.race([
        contents.capturePage(),
        new Promise<undefined>(resolve => { setTimeout(resolve, 5_000); }),
      ]);
      if (image === undefined || image.isEmpty()) {
        skipped.push(contents.getURL());
        return;
      }
      layers.push({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, png: image.toPNG().toString('base64') });
    };
    await add(win.webContents, { x: 0, y: 0, width, height });
    for (const child of win.contentView.children) {
      const bounds = child.getBounds();
      if (!child.getVisible() || bounds.width <= 0 || bounds.height <= 0) continue;
      await add((child as Partial<Electron.WebContentsView>).webContents, bounds);
    }
    return { width, height, layers, skipped };
  }, auxiliary.source);
}

async function composite(window: Page, capture: Capture): Promise<Buffer> {
  const base64 = await window.evaluate(async ({ width, height, layers }: Capture) => {
    const bitmaps = await Promise.all(layers.map(layer => {
      const bytes = Uint8Array.from(atob(layer.png), char => char.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    }));
    const scale = bitmaps.length > 0 && width > 0 ? bitmaps[0]!.width / width : 1;
    const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    layers.forEach((layer, index) => {
      context.drawImage(bitmaps[index]!, layer.x * scale, layer.y * scale, layer.width * scale, layer.height * scale);
    });
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return btoa(binary);
  }, capture);
  return Buffer.from(base64, 'base64');
}

export function snapshotDir(testInfo: TestInfo): string {
  const spec = basename(testInfo.file).replace(/\.spec\.ts$/, '');
  const title = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || testInfo.testId;
  const repeat = testInfo.repeatEachIndex > 0 ? `-repeat${testInfo.repeatEachIndex}` : '';
  return join(testInfo.project.outputDir, '..', 'screens', spec, `${title}${repeat}`);
}

export async function saveSnapshot(testInfo: TestInfo, electron: ElectronApplication, window: Page, auxiliary: RegExp, index: number, name: string): Promise<void> {
  const dir = snapshotDir(testInfo);
  if (index === 1) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${String(index).padStart(2, '0')}-${name}.png`);
  const capture = await captureLayers(electron, auxiliary);
  if (capture.skipped.length > 0) testInfo.annotations.push({ type: 'snapshot', description: `${name}: no frame within 5 s from ${capture.skipped.join(', ')}` });
  await writeFile(file, await composite(window, capture));
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}
