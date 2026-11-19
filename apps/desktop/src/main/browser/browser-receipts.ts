import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { app, nativeImage, type WebContents } from 'electron';
import { browserValidators, type BrowserReceiptImage } from '../../shared/browser-receipt';
import type { ReceiptBitmap } from './browser-receipt-image';
import { log } from '../diagnostics/log';

const AUTOMATION_WORLD_ID = 1001;
const MAX_OUTPUT_WIDTH = 720;
const OUTPUT_QUALITY = 72;
const CAPTURE_TIMEOUT_MS = 150;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReceiptFrame {
  viewport: { width: number; height: number };
  crop: Rect;
  point?: { x: number; y: number };
  box?: Rect | null;
}

interface CapturedReceipt {
  id: string;
  directory: string;
  data: string;
  frame: ReceiptFrame;
}

interface ReceiptScope {
  sessionId: string | undefined;
  attempted: boolean;
  receipt?: CapturedReceipt;
}

const scope = new AsyncLocalStorage<ReceiptScope>();
interface CropWorker {
  worker: Worker;
  jobs: Map<number, (bitmap: ReceiptBitmap | null) => void>;
}

let cropWorker: CropWorker | null = null;
let nextCropJob = 0;
const pendingWrites = new Map<string, Set<Promise<void>>>();
const deletedSessions = new Set<string>();

function root(): string {
  return join(app.getPath('userData'), 'browser-receipts');
}

function sessionDirectory(sessionId: string): string | null {
  return browserValidators.sessionId.Check(sessionId) ? join(root(), sessionId) : null;
}

function finite(...values: unknown[]): boolean {
  return values.every(value => typeof value === 'number' && Number.isFinite(value));
}

function isRect(value: unknown): value is Rect {
  const rect = value as Rect | null;
  return rect !== null && typeof rect === 'object' && finite(rect.x, rect.y, rect.width, rect.height) && rect.width > 0 && rect.height > 0;
}

function isFrame(value: unknown): value is ReceiptFrame {
  const frame = value as ReceiptFrame | null;
  if (frame === null || typeof frame !== 'object' || !isRect({ x: 0, y: 0, ...frame.viewport }) || !isRect(frame.crop)) return false;
  const point = frame.point === undefined || (typeof frame.point === 'object' && frame.point !== null && finite(frame.point.x, frame.point.y));
  const box = frame.box === undefined || frame.box === null || isRect(frame.box);
  return point && box && (frame.point !== undefined || isRect(frame.box));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function marks(frame: ReceiptFrame): Pick<BrowserReceiptImage, 'point' | 'box'> {
  const { crop, point, box } = frame;
  const inside = isRect(box) && box.x >= crop.x && box.y >= crop.y && box.x + box.width <= crop.x + crop.width && box.y + box.height <= crop.y + crop.height;
  return {
    ...(point ? { point: { x: clamp((point.x - crop.x) / crop.width), y: clamp((point.y - crop.y) / crop.height) } } : {}),
    ...(inside ? { box: { x: (box.x - crop.x) / crop.width, y: (box.y - crop.y) / crop.height, width: box.width / crop.width, height: box.height / crop.height } } : {}),
  };
}

function trackWrite(sessionId: string, write: Promise<void>): void {
  const writes = pendingWrites.get(sessionId) ?? new Set<Promise<void>>();
  pendingWrites.set(sessionId, writes);
  writes.add(write);
  void write.finally(() => {
    writes.delete(write);
    if (writes.size === 0 && pendingWrites.get(sessionId) === writes) pendingWrites.delete(sessionId);
  });
}

async function writesSettled(sessionId: string): Promise<void> {
  const writes = pendingWrites.get(sessionId);
  if (writes !== undefined) await Promise.all(writes);
}

export async function settleBrowserReceiptWritesForTest(): Promise<void> {
  while (pendingWrites.size > 0) await Promise.all([...pendingWrites.values()].flatMap((writes) => [...writes]));
}

async function store(directory: string, id: string, data: Buffer, meta: object): Promise<void> {
  const image = join(directory, `${id}.jpg`);
  const details = join(directory, `${id}.json`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(image, data, { flag: 'wx', mode: 0o600 });
    await writeFile(details, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    log.warn(`[kimi-desktop] browser action receipt could not be saved: ${reason(error)}`);
    await Promise.all([rm(image, { force: true }), rm(details, { force: true })]).catch(() => undefined);
  }
}

function receiptWorker(): CropWorker {
  if (cropWorker !== null) return cropWorker;
  const current: CropWorker = {
    worker: new Worker(fileURLToPath(new URL('./browser-receipt-worker.cjs', import.meta.url)), { name: 'kimi-browser-receipts' }),
    jobs: new Map(),
  };
  const { worker, jobs } = current;
  worker.unref();
  const fail = (message: string) => {
    if (cropWorker === current) cropWorker = null;
    if (jobs.size > 0) log.warn(`[kimi-desktop] browser action receipt worker stopped: ${message}`);
    for (const settle of jobs.values()) settle(null);
    jobs.clear();
  };
  worker.on('message', (message: { id: number; bitmap: ReceiptBitmap | null; error?: string }) => {
    if (message.error !== undefined) log.warn(`[kimi-desktop] browser action receipt could not be cropped: ${message.error}`);
    jobs.get(message.id)?.(message.bitmap);
    jobs.delete(message.id);
  });
  worker.on('error', error => fail(reason(error)));
  worker.on('exit', code => fail(`exit code ${code}`));
  cropWorker = current;
  return current;
}

function cropInWorker(receipt: CapturedReceipt): Promise<ReceiptBitmap | null> {
  return new Promise((resolve) => {
    const id = ++nextCropJob;
    let owner: CropWorker | undefined;
    try {
      owner = receiptWorker();
      owner.jobs.set(id, resolve);
      owner.worker.postMessage({ id, data: receipt.data, viewport: receipt.frame.viewport, crop: receipt.frame.crop, maxWidth: MAX_OUTPUT_WIDTH });
    } catch (error) {
      owner?.jobs.delete(id);
      log.warn(`[kimi-desktop] browser action receipt worker could not start: ${reason(error)}`);
      resolve(null);
    }
  });
}

async function finish(sessionId: string, receipt: CapturedReceipt): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  if (deletedSessions.has(sessionId)) return;
  const bitmap = await cropInWorker(receipt);
  if (bitmap === null || deletedSessions.has(sessionId)) return;
  const image = nativeImage.createFromBitmap(Buffer.from(bitmap.bgra.buffer, bitmap.bgra.byteOffset, bitmap.bgra.byteLength), { width: bitmap.width, height: bitmap.height });
  if (image.isEmpty()) return;
  const { frame } = receipt;
  await store(receipt.directory, receipt.id, image.toJPEG(OUTPUT_QUALITY), { width: frame.crop.width, height: frame.crop.height, ...marks(frame) });
}

async function capture(contents: WebContents, sessionId: string, frameCode: string, expired: () => boolean): Promise<CapturedReceipt | undefined> {
  const directory = sessionDirectory(sessionId);
  if (directory === null || deletedSessions.has(sessionId) || contents.isDestroyed() || !contents.debugger.isAttached()) return undefined;
  const frame: unknown = await contents.executeJavaScriptInIsolatedWorld(AUTOMATION_WORLD_ID, [{ code: frameCode }], true);
  if (!isFrame(frame) || expired()) return undefined;
  const screenshot = await contents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png', optimizeForSpeed: true, captureBeyondViewport: false,
  }) as { data?: unknown } | undefined;
  if (typeof screenshot?.data !== 'string' || screenshot.data === '' || expired() || deletedSessions.has(sessionId)) return undefined;
  return { id: `r-${randomBytes(6).toString('hex')}`, directory, data: screenshot.data, frame };
}

export function browserReceiptWanted(): boolean {
  const current = scope.getStore();
  return current !== undefined && current.sessionId !== undefined && !current.attempted && !deletedSessions.has(current.sessionId);
}

export async function captureBrowserReceipt(contents: WebContents, frameCode: string): Promise<void> {
  const current = scope.getStore();
  if (current === undefined || current.sessionId === undefined || current.attempted) return;
  current.attempted = true;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = capture(contents, current.sessionId, frameCode, () => timedOut).catch((error: unknown) => {
    log.warn(`[kimi-desktop] browser action receipt was not captured: ${reason(error)}`);
    return undefined;
  });
  current.receipt = await Promise.race([
    work,
    new Promise<undefined>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(undefined); }, CAPTURE_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
}

export async function withBrowserReceipt<T>(sessionId: string | undefined, work: () => Promise<T>): Promise<{ value: T; receiptId: string | undefined }> {
  const current: ReceiptScope = { sessionId, attempted: false };
  const value = await scope.run(current, work);
  const { receipt } = current;
  if (receipt === undefined || sessionId === undefined || deletedSessions.has(sessionId)) return { value, receiptId: undefined };
  trackWrite(sessionId, finish(sessionId, receipt).catch((error: unknown) => {
    log.warn(`[kimi-desktop] browser action receipt could not be saved: ${reason(error)}`);
  }));
  return { value, receiptId: receipt.id };
}

export async function readBrowserReceipt(sessionId: string, receiptId: string): Promise<BrowserReceiptImage | null> {
  const directory = sessionDirectory(sessionId);
  if (directory === null || !browserValidators.receiptId.Check(receiptId)) return null;
  await writesSettled(sessionId);
  try {
    const [image, meta] = await Promise.all([readFile(join(directory, `${receiptId}.jpg`)), readFile(join(directory, `${receiptId}.json`), 'utf8')]);
    const parsed = JSON.parse(meta) as { width?: unknown; height?: unknown; point?: { x?: unknown; y?: unknown }; box?: unknown };
    if (!finite(parsed.width, parsed.height)) return null;
    return {
      id: receiptId, mimeType: 'image/jpeg', data: image.toString('base64'),
      width: parsed.width as number, height: parsed.height as number,
      ...(parsed.point && finite(parsed.point.x, parsed.point.y) ? { point: { x: parsed.point.x as number, y: parsed.point.y as number } } : {}),
      ...(isRect(parsed.box) ? { box: { x: parsed.box.x, y: parsed.box.y, width: parsed.box.width, height: parsed.box.height } } : {}),
    };
  } catch {
    return null;
  }
}

export async function deleteBrowserReceipts(sessionId: string): Promise<void> {
  const directory = sessionDirectory(sessionId);
  if (directory === null) return;
  deletedSessions.add(sessionId);
  await writesSettled(sessionId);
  await rm(directory, { recursive: true, force: true });
}

export async function copyBrowserReceipts(sourceId: string, targetId: string): Promise<void> {
  const source = sessionDirectory(sourceId);
  const target = sessionDirectory(targetId);
  if (source === null || target === null || source === target) return;
  await writesSettled(sourceId);
  let names: string[];
  try {
    names = (await readdir(source)).filter(name => /^r-[0-9a-f]{12}\.(?:jpg|json)$/.test(name));
  } catch {
    return;
  }
  if (names.length === 0) return;
  await mkdir(target, { recursive: true, mode: 0o700 });
  await Promise.all(names.map(async (name) => {
    try {
      await copyFile(join(source, name), join(target, name), constants.COPYFILE_EXCL);
      await chmod(join(target, name), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }));
}

export async function pruneBrowserReceipts(now = Date.now()): Promise<void> {
  let sessions: string[];
  try {
    sessions = await readdir(root());
  } catch {
    return;
  }
  await Promise.all(sessions.map(async (name) => {
    const directory = sessionDirectory(name);
    if (directory === null) return;
    await writesSettled(name);
    try {
      const files = await readdir(directory);
      await Promise.all(files.map(async (file) => {
        const path = join(directory, file);
        if (now - (await stat(path)).mtimeMs >= RETENTION_MS) await rm(path, { force: true });
      }));
      await rmdir(directory).catch(() => undefined);
    } catch (error) {
      log.warn(`[kimi-desktop] browser action receipts could not be pruned: ${reason(error)}`);
    }
  }));
}

export function scheduleBrowserReceiptPruning(): void {
  const prune = () => { void pruneBrowserReceipts(); };
  prune();
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
}
