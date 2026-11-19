import type { BrowserAnnotationCaptureAction } from '../../shared/browser-annotation';
import { app, nativeImage } from 'electron';
import type { WebContents } from 'electron';
import type { MainWindow } from '../window/main-window';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBrowserReferenceId, parseBrowserCapture } from '@moonshot-ai/app-core/browser-reference';
import { browserAnnotationCrop, type BrowserAnnotationAsset, type BrowserAnnotationLocation, type BrowserAnnotationPickOptions, type BrowserAnnotationPickResult } from '../../shared/browser-annotation';
import { getBrowserPage } from './browser-view';
import { suspendBrowserMouseTouch } from './browser-debugger';
import { log } from '../diagnostics/log';
import { BROWSER_ANNOTATION_WORLD, browserAnnotationCommandScript, browserAnnotationPickerScript, browserAnnotationScreenshotScript } from './browser-annotation-script';

const assetCollectionCutoff = Date.now() - 24 * 60 * 60 * 1000;
const usedAssets = new Set<string>();

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const bindings = new Map<string, { browserId: string; contents: WeakRef<WebContents>; generation: number; options: BrowserAnnotationPickOptions }>();
const assetOperations = new Map<string, Promise<void>>();
const pendingAssets = new Map<string, { owner: string; store: BrowserAnnotationAssetStore; prepared?: boolean }>();
let captureOwner = randomUUID();
let initializedRoot = '';
let stagingReady = Promise.resolve();
const picks = new Map<string, { id: string; cancel: () => void }>();

async function isolated(contents: WebContents, code: string): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code }], true);
}

export class BrowserAnnotationAssetStore {
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    if (!isBrowserReferenceId(id)) throw new Error('Invalid browser annotation asset id');
    return join(this.directory, `${id}.png`);
  }

  async write(id: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Browser annotation screenshot is too large');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(id), bytes, { flag: 'wx', mode: 0o600 });
  }

  async promote(id: string, destination: BrowserAnnotationAssetStore): Promise<void> {
    await mkdir(destination.directory, { recursive: true, mode: 0o700 });
    await rename(this.path(id), destination.path(id));
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  async collect(retained: ReadonlySet<string>, cutoff: number): Promise<void> {
    let files;
    try { files = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.png')) continue;
      const id = file.name.slice(0, -4);
      if (!isBrowserReferenceId(id) || retained.has(id)) continue;
      const stat = await lstat(this.path(id));
      if (stat.mtimeMs >= cutoff || usedAssets.has(id) || pendingAssets.has(id)) continue;
      await this.remove(id);
    }
  }

  async read(id: string): Promise<BrowserAnnotationAsset> {
    const file = this.path(id);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) throw new Error('Invalid browser annotation asset');
    const bytes = await readFile(file);
    if (bytes.length > MAX_ASSET_BYTES) throw new Error('Browser annotation screenshot is too large');
    return { data: bytes.toString('base64'), name: `browser-${id}.png`, mimeType: 'image/png', size: bytes.length };
  }
}

function assets(): BrowserAnnotationAssetStore {
  return new BrowserAnnotationAssetStore(join(app.getPath('userData'), 'browser-annotation-assets'));
}

function stagedAssets(owner: string): BrowserAnnotationAssetStore {
  const root = join(app.getPath('userData'), 'browser-annotation-assets');
  if (initializedRoot !== root) {
    initializedRoot = root;
    stagingReady = rm(join(root, 'staging'), { recursive: true, force: true });
  }
  return new BrowserAnnotationAssetStore(join(root, 'staging', owner));
}

export async function resetBrowserAnnotationCaptures(): Promise<void> {
  const previous = captureOwner;
  captureOwner = randomUUID();
  for (const browserId of picks.keys()) cancelBrowserAnnotationPick(browserId);
  const ids = [...pendingAssets].filter(([, pending]) => pending.owner === previous).map(([id]) => id);
  await Promise.all(ids.map((id) => completeBrowserAnnotationCapture(id, 'cancel')));
  await stagingReady;
  await rm(join(app.getPath('userData'), 'browser-annotation-assets', 'staging', previous), { recursive: true, force: true });
}

export function attachBrowserAnnotationWindow(win: MainWindow): void {
  stagedAssets(captureOwner);
  void stagingReady.catch((error) => log.warn(`[kimi-desktop] annotation staging cleanup failed: ${String(error)}`));
  const reset = (): void => { void resetBrowserAnnotationCaptures().catch((error) => log.warn(`[kimi-desktop] annotation capture cleanup failed: ${String(error)}`)); };
  win.webContents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) reset(); });
  win.webContents.on('render-process-gone', reset);
  win.once('closed', reset);
}

export function isBrowserAnnotationPicking(browserId: string): boolean {
  return picks.has(browserId);
}

export function cancelBrowserAnnotationPick(browserId: string): void {
  picks.get(browserId)?.cancel();
  const page = getBrowserPage(browserId);
  if (page !== null) void isolated(page.webContents, browserAnnotationCommandScript('cancel', '')).catch(() => {});
}

export async function pickBrowserAnnotation(browserId: string, options: BrowserAnnotationPickOptions): Promise<BrowserAnnotationPickResult | null> {
  cancelBrowserAnnotationPick(browserId);
  const page = getBrowserPage(browserId);
  if (page === null || !page.visible) throw new Error('Browser page is not visible');
  const generation = page.generation;
  const id = `bc_${randomUUID()}`;
  const owner = captureOwner;
  const staged = stagedAssets(owner);
  let aborted = false;
  let delivered = false;
  let cancel = (): void => {};
  const cancelled = new Promise<null>((resolve) => { cancel = () => { aborted = true; resolve(null); }; });
  picks.set(browserId, { id, cancel });
  const contents = page.webContents;
  const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (!inPlace && mainFrame) cancel();
  };
  contents.on('did-start-navigation', navigated);
  contents.once('destroyed', cancel);
  let restoreMouseTouch = async (): Promise<void> => {};
  try {
    restoreMouseTouch = await suspendBrowserMouseTouch(contents);
    if (aborted) return null;
    contents.focus();
    const raw = await Promise.race([isolated(contents, browserAnnotationPickerScript(id, options)).catch(() => null), cancelled]);
    if (raw === null || aborted || picks.get(browserId)?.id !== id) return null;
    const capture = parseBrowserCapture(raw);
    if (capture === null || capture.id !== id) throw new Error('Invalid browser annotation selection');
    const current = getBrowserPage(browserId);
    if (current === null || current.webContents !== contents || current.generation !== generation || !current.visible) return null;
    capture.bindingId = id;
    capture.viewport.zoomFactor = contents.getZoomFactor();
    const clip = browserAnnotationCrop(capture.target.bounds, capture.viewport, capture.viewport);
    if (clip === null) throw new Error('Browser annotation is outside the viewport');
    await isolated(contents, browserAnnotationScreenshotScript(id, true, { bounds: clip.crop, ordinal: capture.ordinal, options }));
    const image = nativeImage.createFromBuffer((await contents.capturePage()).toPNG());
    const after = getBrowserPage(browserId);
    if (after === null || after.webContents !== contents || after.generation !== generation || !after.visible || aborted || picks.get(browserId)?.id !== id) return null;
    const bytes = image.toPNG();
    await stagingReady;
    if (aborted || owner !== captureOwner) return null;
    pendingAssets.set(id, { owner, store: staged });
    await staged.write(id, bytes);
    if (aborted || picks.get(browserId)?.id !== id) return null;
    const dimensions = image.getSize();
    const scale = Math.min(1, 320 / dimensions.width, 240 / dimensions.height);
    const thumbnail = image.resize({ width: Math.max(1, Math.floor(dimensions.width * scale)), height: Math.max(1, Math.floor(dimensions.height * scale)) }).toDataURL();
    capture.screenshot = { attachmentId: id, crop: { x: 0, y: 0, width: capture.viewport.width, height: capture.viewport.height }, pixelWidth: dimensions.width, pixelHeight: dimensions.height };
    bindings.set(id, { browserId, contents: new WeakRef(contents), generation, options });
    const anchor = { x: after.bounds.x + clip.crop.x * after.bounds.width / capture.viewport.width, y: after.bounds.y + clip.crop.y * after.bounds.height / capture.viewport.height, width: clip.crop.width * after.bounds.width / capture.viewport.width, height: clip.crop.height * after.bounds.height / capture.viewport.height };
    delivered = true;
    return { capture, anchor, assetId: id, thumbnail, size: bytes.length };
  } finally {
    await restoreMouseTouch();
    await isolated(contents, browserAnnotationScreenshotScript(id, false)).catch(() => {});
    contents.removeListener('did-start-navigation', navigated);
    contents.removeListener('destroyed', cancel);
    if (picks.get(browserId)?.id === id) picks.delete(browserId);
    if (!delivered) {
      await isolated(contents, browserAnnotationCommandScript('remove', id)).catch(() => {});
      await completeBrowserAnnotationCapture(id, 'cancel');
      await staged.remove(id);
    }
  }
}

export function completeBrowserAnnotationCapture(id: string, action: BrowserAnnotationCaptureAction): Promise<void> {
  const task = (assetOperations.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => finishCapture(id, action));
  assetOperations.set(id, task);
  const release = () => { if (assetOperations.get(id) === task) assetOperations.delete(id); };
  void task.then(release, release);
  return task;
}

async function finishCapture(id: string, action: BrowserAnnotationCaptureAction): Promise<void> {
  const pending = pendingAssets.get(id);
  if (action !== 'cancel') {
    if (pending === undefined) { await assets().read(id); return; }
    if (action === 'prepare') {
      if (!pending.prepared) {
        const destination = assets();
        await pending.store.promote(id, destination);
        pending.store = destination;
        pending.prepared = true;
      }
    } else {
      if (!pending.prepared) throw new Error('Annotation capture is not prepared');
      usedAssets.add(id);
      pendingAssets.delete(id);
    }
    return;
  }
  if (pending === undefined) return;
  pendingAssets.delete(id);
  const binding = bindings.get(id);
  bindings.delete(id);
  const contents = binding?.contents.deref();
  if (contents !== undefined && !contents.isDestroyed()) await isolated(contents, browserAnnotationCommandScript('remove', id)).catch(() => {});
  await pending.store.remove(id);
}

export function readBrowserAnnotationAsset(id: string): Promise<BrowserAnnotationAsset> {
  usedAssets.add(id);
  return (pendingAssets.get(id)?.store ?? assets()).read(id);
}

export async function showBrowserAnnotation(id: string, ordinal: number, locate: boolean): Promise<BrowserAnnotationLocation> {
  const binding = bindings.get(id);
  if (binding === undefined) return { located: false };
  const page = getBrowserPage(binding.browserId);
  if (page === null || page.webContents !== binding.contents.deref() || page.generation !== binding.generation) {
    bindings.delete(id);
    return { located: false };
  }
  if (locate && !page.visible) return { located: false, browserId: binding.browserId };
  const located = await isolated(page.webContents, browserAnnotationCommandScript(locate ? 'locate' : 'mark', id, ordinal, binding.options.borderColor, binding.options.labelFont)).catch(() => false);
  return { located: located === true, browserId: binding.browserId };
}

export async function hideBrowserAnnotation(id: string): Promise<void> {
  const binding = bindings.get(id);
  const contents = binding?.contents.deref();
  if (contents === undefined || contents.isDestroyed()) return;
  await isolated(contents, browserAnnotationCommandScript('unmark', id)).catch(() => {});
}

export function browserAnnotationViewBounds(id: string): { x: number; y: number; width: number; height: number } | undefined {
  const binding = bindings.get(id);
  if (!binding) return undefined;
  const page = getBrowserPage(binding.browserId);
  if (!page?.visible || page.generation !== binding.generation || page.webContents !== binding.contents.deref()) return undefined;
  return page.bounds;
}

export async function collectBrowserAnnotationAssets(retained: readonly string[]): Promise<void> {
  await assets().collect(new Set(retained), assetCollectionCutoff);
}
