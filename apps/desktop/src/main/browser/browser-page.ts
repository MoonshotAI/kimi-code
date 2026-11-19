import { browserElementSemantics, SENSITIVE_AUTOCOMPLETE_TOKENS } from './browser-element-semantics';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeBrowserImage } from './browser-image';
import { retainBrowserScreenshot } from './browser-crop';
import { randomUUID } from 'node:crypto';
import { nativeImage, type WebContents } from 'electron';
import { withBrowserDebugger } from './browser-debugger';

import {
  BROWSER_LOCAL_FILE_REFUSAL,
  type BrowserElementsSnapshot,
  type BrowserClickFeedback,
  type BrowserErrorCode,
  type BrowserRunRequest,
  type BrowserVisualSnapshot,
} from '../../shared/browser-automation';
import { getBrowserPage, keepBrowserPageRendering } from './browser-view';
import { dispatchBrowserKeys, runBrowserInput, type BrowserInputSend, type BrowserInputGuard } from './browser-input';
import type { BrowserActivityTarget } from './browser-control';
import { browserReceiptWanted, captureBrowserReceipt } from './browser-receipts';

const AUTOMATION_WORLD_ID = 1001;
const VISUAL_CAPTURE_TIMEOUT_MS = 10_000;
const MAX_ELEMENT_SNAPSHOT_ITEMS = 2_000;
const ELEMENT_STATE_ENTRIES = '[globalThis.__kimiBrowserElementState, globalThis.__kimiBrowserElementState?.probe]';

type VisualClickRequest = Extract<BrowserRunRequest, { operation: 'page.visual.click' }>;
type VisualHoverRequest = Extract<BrowserRunRequest, { operation: 'page.visual.hover' }>;
type VisualScrollRequest = Extract<BrowserRunRequest, { operation: 'page.visual.scroll' }>;
type VisualDragRequest = Extract<BrowserRunRequest, { operation: 'page.visual.drag' }>;
type VisualDragPathRequest = Extract<BrowserRunRequest, { operation: 'page.visual.drag_path' }>;
type VisualTypeRequest = Extract<BrowserRunRequest, { operation: 'page.visual.type_text' }>;
type VisualKeyRequest = Extract<BrowserRunRequest, { operation: 'page.visual.press_key' }>;
type ElementRequest = Extract<BrowserRunRequest, { operation: `page.element.${string}` }>;

interface PagePosition {
  scrollX: number;
  scrollY: number;
  deviceScaleFactor: number;
  cssWidth: number;
  cssHeight: number;
}

interface VisualSnapshotRecord extends Pick<PagePosition, 'cssWidth' | 'cssHeight'> {
  webContentsId: number;
  snapshotId: string;
  browserId: string;
  generation: number;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

interface ElementCommandResult {
  ok: boolean;
  code?: BrowserErrorCode;
  message?: string;
  point?: { x: number; y: number };
  changed?: boolean;
  needsClick?: boolean;
}

export class BrowserPageError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserPageError';
  }
}

export function shouldRedactBrowserElementValue(type: string, autocomplete: string): boolean {
  if (type.trim().toLowerCase() === 'password') return true;
  return autocomplete
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.includes(token));
}

const visualSnapshots = new Map<string, VisualSnapshotRecord>();

function requirePage(browserId: string) {
  const page = getBrowserPage(browserId);
  if (page === null) throw new BrowserPageError('PAGE_NOT_READY', 'Browser page is not ready.');
  if (page.localFile) throw new BrowserPageError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
  if (page.bounds.width < 1 || page.bounds.height < 1) {
    throw new BrowserPageError('PAGE_NOT_READY', 'Browser page has no usable viewport.');
  }
  return page;
}

export const BROWSER_PAGE_SCRIPT_TIMEOUT_MS = 15_000;
const SCRIPT_TIMEOUT_MESSAGE = 'The page did not respond in time. It may be showing a dialog; check page.dialog.get.';
const ACTION_UNDETERMINED_MESSAGE = 'The page did not respond in time, so it is unknown whether the action took effect; it may still apply once the page responds. Check page.dialog.get and read the page state before retrying.';

export async function isolated<TResult>(webContents: WebContents, code: string, timeoutMs = BROWSER_PAGE_SCRIPT_TIMEOUT_MS): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const script = webContents.executeJavaScriptInIsolatedWorld(AUTOMATION_WORLD_ID, [{ code }], true) as Promise<TResult>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserPageError('PAGE_NOT_READY', SCRIPT_TIMEOUT_MESSAGE)), timeoutMs);
  });
  try {
    return await Promise.race([script, timeout]);
  } finally {
    clearTimeout(timer);
    script.catch(() => {});
  }
}

async function readPagePosition(webContents: WebContents): Promise<PagePosition> {
  const value = await isolated<unknown>(
    webContents,
    `(() => ({
      cssWidth: window.visualViewport?.width || innerWidth,
      cssHeight: window.visualViewport?.height || innerHeight,
      scrollX: Number.isFinite(window.scrollX) ? window.scrollX : 0,
      scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0,
      deviceScaleFactor: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1
    }))()`,
  );
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { scrollX: 0, scrollY: 0, deviceScaleFactor: 1, cssWidth: 0, cssHeight: 0 };
  }
  const raw = value as Record<string, unknown>;
  return {
    cssWidth: typeof raw['cssWidth'] === 'number' && Number.isFinite(raw['cssWidth']) ? raw['cssWidth'] : 0,
    cssHeight: typeof raw['cssHeight'] === 'number' && Number.isFinite(raw['cssHeight']) ? raw['cssHeight'] : 0,
    scrollX: typeof raw['scrollX'] === 'number' && Number.isFinite(raw['scrollX']) ? raw['scrollX'] : 0,
    scrollY: typeof raw['scrollY'] === 'number' && Number.isFinite(raw['scrollY']) ? raw['scrollY'] : 0,
    deviceScaleFactor:
      typeof raw['deviceScaleFactor'] === 'number' &&
      Number.isFinite(raw['deviceScaleFactor']) &&
      raw['deviceScaleFactor'] > 0
        ? raw['deviceScaleFactor']
        : 1,
  };
}

function captureDeadline(signal?: AbortSignal): { expired: Promise<never>; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserPageError('PAGE_NOT_READY', 'Browser page did not render the screenshot in time; capture again.')), VISUAL_CAPTURE_TIMEOUT_MS);
    abort = () => reject(new BrowserPageError('OPERATION_ABORTED', 'Browser operation was aborted.'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  expired.catch(() => undefined);
  return {
    expired,
    dispose: () => {
      clearTimeout(timer);
      if (abort !== undefined) signal?.removeEventListener('abort', abort);
    },
  };
}

function beforeDeadline<T>(work: Promise<T>, expired: Promise<never>): Promise<T> {
  work.catch(() => undefined);
  return Promise.race([work, expired]);
}

export async function captureBrowserVisual(browserId: string, signal?: AbortSignal): Promise<BrowserVisualSnapshot> {
  if (signal?.aborted) throw new BrowserPageError('OPERATION_ABORTED', 'Browser operation was aborted.');
  const initial = requirePage(browserId);
  if (initial.committed === false) throw new BrowserPageError('PAGE_NOT_READY', 'Browser page is still navigating; capture again after it loads.');
  const page = { ...initial, bounds: { ...initial.bounds } };
  const deadline = captureDeadline(signal);
  const release = keepBrowserPageRendering(page.webContents);
  let position: PagePosition;
  let screenshot: { data: string };
  let after: PagePosition;
  try {
    position = await beforeDeadline(readPagePosition(page.webContents), deadline.expired);
    screenshot = await withBrowserDebugger(page.webContents, connection => beforeDeadline(
      connection.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as Promise<{ data: string }>,
      deadline.expired,
    ));
    after = await beforeDeadline(readPagePosition(page.webContents), deadline.expired);
  } finally {
    deadline.dispose();
    release();
  }
  const originalData: Buffer = Buffer.from(screenshot.data, 'base64');
  const image = nativeImage.createFromBuffer(originalData);
  if (after.scrollX !== position.scrollX || after.scrollY !== position.scrollY ||
    after.cssWidth !== position.cssWidth || after.cssHeight !== position.cssHeight ||
    after.deviceScaleFactor !== position.deviceScaleFactor) {
    throw new BrowserPageError('PAGE_NOT_READY', 'Browser page moved while capturing the screenshot; capture again.');
  }
  const current = getBrowserPage(browserId);
  if (current === null || current.webContents !== page.webContents || current.generation !== page.generation || current.committed === false ||
    current.bounds.width !== page.bounds.width || current.bounds.height !== page.bounds.height ||
    current.inputScale !== page.inputScale) {
    throw new BrowserPageError('PAGE_NOT_READY', 'Browser page changed while capturing the screenshot; capture again.');
  }
  if (image.isEmpty()) throw new BrowserPageError('PAGE_NOT_READY', 'Browser page produced an empty screenshot.');
  const { data, ...size } = encodeBrowserImage(image);
  const snapshotId = `visual-${randomUUID()}`;
  visualSnapshots.set(snapshotId, {
    webContentsId: page.webContents.id,
    snapshotId,
    browserId,
    generation: page.generation,
    imageWidth: size.width,
    imageHeight: size.height,
    viewportWidth: page.bounds.width,
    viewportHeight: page.bounds.height,
    cssWidth: position.cssWidth,
    cssHeight: position.cssHeight,
  });
  const tabSnapshots = [...visualSnapshots.values()].filter(record => record.browserId === browserId);
  for (const record of tabSnapshots.slice(0, -8)) visualSnapshots.delete(record.snapshotId);
  while (visualSnapshots.size > 64) visualSnapshots.delete(visualSnapshots.keys().next().value!);
  const cropAvailable = retainBrowserScreenshot(browserId, page.webContents.id, snapshotId, originalData, size.width, size.height);
  return {
    snapshotId,
    mimeType: 'image/png',
    cropAvailable,
    data: data.toString('base64'),
    width: size.width,
    height: size.height,
    deviceScaleFactor: position.deviceScaleFactor,
    viewport: { width: page.bounds.width, height: page.bounds.height },
  };
}

function requireVisualSnapshot(
  browserId: string,
  snapshotId: string,
): { page: NonNullable<ReturnType<typeof getBrowserPage>>; record: VisualSnapshotRecord } {
  const page = requirePage(browserId);
  const record = visualSnapshots.get(snapshotId);
  if (record === undefined || record.browserId !== browserId || record.webContentsId !== page.webContents.id || record.generation !== page.generation) {
    throw new BrowserPageError('STALE_SNAPSHOT', 'Snapshot is unavailable or belongs to a different document; capture a new screenshot.');
  }
  return { page, record };
}

function imagePointToViewport(record: VisualSnapshotRecord, x: number, y: number): { x: number; y: number } {
  if (x < 0 || y < 0 || x >= record.imageWidth || y >= record.imageHeight) {
    throw new BrowserPageError('COORDINATE_OUT_OF_BOUNDS', 'The coordinate is outside the visual snapshot.');
  }
  return {
    x: (x / record.imageWidth) * (record.cssWidth || record.viewportWidth),
    y: (y / record.imageHeight) * (record.cssHeight || record.viewportHeight),
  };
}

async function sendClick(
  send: BrowserInputSend,
  point: { x: number; y: number },
  button: 'left' | 'right' | 'middle',
  clickCount: 1 | 2,
): Promise<void> {
  for (let count = 1; count <= clickCount; count += 1) {
    try {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: count });
    } finally {
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: count });
    }
  }
}

async function captureRenderedReceipt(webContents: WebContents, frameCode: string): Promise<void> {
  const release = keepBrowserPageRendering(webContents);
  try {
    await captureBrowserReceipt(webContents, frameCode);
  } finally {
    release();
  }
}

async function runPageInput(browserId: string, work: (send: BrowserInputSend, check: () => Promise<void>) => Promise<void>, signal?: AbortSignal, validate?: () => Promise<void>, beforeSend?: BrowserInputGuard, cssCoordinates = false, receiptTarget?: ReceiptFrameRequest['target']): Promise<void> {
  const page = requirePage(browserId);
  const generation = page.generation;
  const width = page.bounds.width;
  const height = page.bounds.height;
  const inputScale = page.inputScale;
  const points = new WeakMap<Record<string, unknown>, { x: number; y: number }>();
  const checkPageIdentity = (): void => {
    const current = requirePage(browserId);
    if (current.webContents !== page.webContents || current.generation !== generation ||
      (!cssCoordinates && (current.bounds.width !== width || current.bounds.height !== height || current.inputScale !== inputScale))) {
      throw new BrowserPageError('PAGE_NOT_READY', 'Browser page changed before input could be sent.');
    }
  };
  const checkPage = async (): Promise<void> => {
    await validate?.();
    checkPageIdentity();
  };
  const captureReceipt = async (method: string, params?: Record<string, unknown>): Promise<void> => {
    if (params?.['type'] === 'mouseReleased' || params?.['type'] === 'keyUp' || !browserReceiptWanted()) return;
    const mouse = method === 'Input.dispatchMouseEvent';
    const scale = cssCoordinates ? 1 : getBrowserPage(browserId)?.inputScale ?? inputScale;
    const x = Number(params?.['x']) / scale, y = Number(params?.['y']) / scale;
    await captureRenderedReceipt(page.webContents, receiptFrameCode({
      mode: mouse ? 'pointer' : 'keyboard',
      ...(mouse && Number.isFinite(x) && Number.isFinite(y) ? { point: { x, y } } : {}),
      ...(receiptTarget === undefined ? {} : { target: receiptTarget }),
    }));
  };
  await runBrowserInput(page.webContents, (send, check) => work(async (method, params) => {
    await captureReceipt(method, params);
    if (cssCoordinates && method === 'Input.dispatchMouseEvent' && typeof params?.['x'] === 'number' && typeof params['y'] === 'number') {
      const scale = getBrowserPage(browserId)?.inputScale ?? inputScale;
      const scaled = { ...params, x: params['x'] * scale, y: params['y'] * scale };
      points.set(scaled, { x: params['x'], y: params['y'] });
      return send(method, scaled);
    }
    return send(method, params);
  }, check), signal, checkPage, async (method, params) => {
    await beforeSend?.(method, params);
    checkPageIdentity();
    const point = params === undefined ? undefined : points.get(params);
    if (point && params) {
      const scale = requirePage(browserId).inputScale;
      params['x'] = point.x * scale;
      params['y'] = point.y * scale;
    }
  });
}

export async function clickBrowserVisual(browserId: string, request: VisualClickRequest, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
  await runPageInput(browserId, async (send) => {
    const { record } = requireVisualSnapshot(browserId, request.snapshotId);
    await sendClick(send, imagePointToViewport(record, request.x, request.y), request.button ?? 'left', request.clickCount ?? 1);
  }, signal, validate, undefined, true);
}

export function visualTargetProbeCode(snapshotId: string, point: { x: number; y: number }, radius: number, scale: { x: number; y: number }, guardRef?: string): string {
  return `(() => {
    const request = ${JSON.stringify({ snapshotId, point, radius, scale, guardRef })};
    const parent = node => node.parentElement || node.getRootNode()?.host;
    const disabled = node => {
      for (let current = node; current; current = parent(current)) {
        if (current.matches(':disabled,[inert],[aria-disabled="true"]')) return true;
      }
      return false;
    };
    const visible = node => {
      for (let current = node; current; current = parent(current)) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const evidence = node => {
      if (!node || /^(CANVAS|IFRAME|EMBED|OBJECT|BODY|HTML)$/.test(node.tagName)) return 'none';
      if (node.matches('button,a[href],input:not([type="hidden"]),select,textarea,summary,[contenteditable="true"],[contenteditable=""]')) return 'native';
      if (node.matches('[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"]')) return 'role';
      if (node.hasAttribute('onclick')) return 'handler';
      return getComputedStyle(node).cursor === 'pointer' ? 'pointer' : 'none';
    };
    const deepHit = (x, y) => {
      let node = document.elementFromPoint(x, y);
      while (node?.shadowRoot) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
      }
      return node;
    };
    const belongs = (node, target) => {
      for (let current = node; current; current = parent(current)) if (current === target) return true;
      return false;
    };
    const hit = deepHit(request.point.x, request.point.y);
    if (request.guardRef) {
      const state = globalThis.__kimiBrowserElementState;
      const target = ${ELEMENT_STATE_ENTRIES}.find(entry => entry?.snapshotId === request.snapshotId)?.elements.get(request.guardRef);
      const interactive = Boolean(target?.isConnected && visible(target) && !disabled(target) && evidence(target) !== 'none' && belongs(hit, target));
      if (interactive && state?.probe?.snapshotId === request.snapshotId) globalThis.__kimiBrowserElementState = state.probe;
      return interactive;
    }
    const owner = node => {
      let pointer = null;
      for (let current = node; current; current = parent(current)) {
        const hint = evidence(current);
        if (hint !== 'none' && hint !== 'pointer') return current;
        if (hint === 'pointer' && !pointer) pointer = current;
      }
      return pointer;
    };
    const target = hit && visible(hit) && !disabled(hit) && !/^(CANVAS|IFRAME|EMBED|OBJECT)$/.test(hit.tagName) ? owner(hit) : null;
    const candidates = [];
    const seen = new Set();
    const add = node => {
      if (seen.has(node) || !visible(node)) return;
      seen.add(node);
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return;
      const dx = Math.max(rect.left - request.point.x, 0, request.point.x - rect.right) * request.scale.x;
      const dy = Math.max(rect.top - request.point.y, 0, request.point.y - rect.bottom) * request.scale.y;
      const distance = Math.hypot(dx, dy);
      if (distance > request.radius) return;
      const hint = evidence(node);
      const isDisabled = disabled(node);
      const clickable = hint !== 'none' && !isDisabled;
      if (clickable && hint === 'pointer' && owner(node) !== node) return;
      if (!clickable && hint === 'none' && node !== hit && node.children.length > 0) return;
      const cx = Math.max(0, Math.min(innerWidth - 1, (rect.left + rect.right) / 2));
      const cy = Math.max(0, Math.min(innerHeight - 1, (rect.top + rect.bottom) / 2));
      if (node !== target && !belongs(deepHit(cx, cy), node)) return;
      const role = (node.getAttribute('role') || (node.tagName === 'BUTTON' ? 'button' : node.tagName === 'A' ? 'link' : 'generic')).slice(0, 80);
      const name = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('alt') || node.getAttribute('placeholder') || (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) ? '' : node.textContent || '');
      candidates.push({ node, distance, data: {
        tagName: node.tagName.toLowerCase(), role, name: name.slice(0, 1024).replace(/\\s+/g, ' ').trim().slice(0, 160),
        ...(node.id ? { id: node.id.slice(0, 128) } : {}), classes: [...node.classList].slice(0, 12).map(value => value.slice(0, 128)),
        clickable, disabled: isDisabled, evidence: hint,
        bounds: { x: rect.x * request.scale.x, y: rect.y * request.scale.y, width: rect.width * request.scale.x, height: rect.height * request.scale.y },
      } });
    };
    if (target) add(target);
    if (hit) add(hit);
    let scanned = 0;
    let truncated = false;
    const visit = root => {
      for (const node of root.querySelectorAll('*')) {
        if (++scanned > 10000) { truncated = true; return; }
        add(node);
        if (node.shadowRoot) visit(node.shadowRoot);
        if (truncated) return;
      }
    };
    if (!candidates.some(item => item.node === target)) visit(document);
    candidates.sort((a, b) => Number(b.node === target) - Number(a.node === target) || Number(b.data.clickable) - Number(a.data.clickable) || a.distance - b.distance);
    if (candidates.length > 24) truncated = true;
    const selected = candidates.slice(0, 24);
    const elements = new Map();
    selected.forEach((item, index) => { if (item.data.clickable) { item.data.ref = 'e' + (index + 1); elements.set(item.data.ref, item.node); } });
    const probe = { snapshotId: request.snapshotId, elements };
    const previous = globalThis.__kimiBrowserElementState;
    globalThis.__kimiBrowserElementState = previous ? { snapshotId: previous.snapshotId, elements: previous.elements, probe } : probe;
    const targetInfo = selected.find(item => item.node === target)?.data;
    const nearby = targetInfo ? [] : selected.map(item => item.data);
    return { outcome: 'no_target', ...(targetInfo ? { target: targetInfo } : {}), nearby,
      elementsSnapshotId: request.snapshotId, radius: request.radius, coordinateSpace: 'image', truncated,
      needsVisualConfirmation: !targetInfo && !nearby.some(item => item.clickable), message: '' };
  })()`;
}

export async function clickBrowserVisualIfInteractive(browserId: string, request: Extract<BrowserRunRequest, { operation: 'page.visual.click_if_interactive' }>, signal?: AbortSignal, validate?: () => Promise<void>): Promise<BrowserClickFeedback> {
  const { page, record } = requireVisualSnapshot(browserId, request.snapshotId);
  imagePointToViewport(record, request.x, request.y);
  const scale = { x: record.imageWidth / (record.cssWidth || record.viewportWidth), y: record.imageHeight / (record.cssHeight || record.viewportHeight) };
  const point = { x: request.x / scale.x, y: request.y / scale.y };
  const elementsSnapshotId = `elements-${randomUUID()}`;
  const result = await isolated<BrowserClickFeedback>(page.webContents, visualTargetProbeCode(elementsSnapshotId, point, request.radius ?? 48, scale));
  if (signal?.aborted) throw new BrowserPageError('OPERATION_ABORTED', 'Browser operation was aborted.');
  if (!result.target?.ref) {
    result.message = result.needsVisualConfirmation
      ? 'No clickable element was detected here or nearby. No click was sent. Confirm the screenshot visually; canvas or frame content may require page.visual.click.'
      : 'No interactive element at the requested point. No click was sent. Inspect nearby candidates and refine with page.element.click using elementsSnapshotId and ref, or choose another visual point.';
    return result;
  }
  await runPageInput(browserId, async send => {
    requireVisualSnapshot(browserId, request.snapshotId);
    await sendClick(send, imagePointToViewport(record, request.x, request.y), 'left', 1);
  }, signal, validate, async () => {
    const valid = await isolated<boolean>(requirePage(browserId).webContents, visualTargetProbeCode(elementsSnapshotId, point, request.radius ?? 48, scale, result.target?.ref));
    if (!valid) throw new BrowserPageError('ELEMENT_NOT_INTERACTABLE', 'The detected target changed or became obscured before the click. Observe again.');
  }, true);
  return { ...result, outcome: 'clicked', message: 'Clicked the interactive element at the requested point. Verify the expected page result separately.' };
}

export async function hoverBrowserVisual(browserId: string, request: VisualHoverRequest, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
  await runPageInput(browserId, async (send) => {
    const { record } = requireVisualSnapshot(browserId, request.snapshotId);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...imagePointToViewport(record, request.x, request.y) });
  }, signal, validate, undefined, true);
}

export async function scrollBrowserVisual(browserId: string, request: VisualScrollRequest, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
  await runPageInput(browserId, async (send) => {
    const { record } = requireVisualSnapshot(browserId, request.snapshotId);
    const point = imagePointToViewport(record, request.x, request.y);
    const steps = Math.max(1, Math.min(12, Math.ceil(Math.max(Math.abs(request.deltaX), Math.abs(request.deltaY)) / 100)));
    for (let step = 0; step < steps; step += 1) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', ...point, deltaX: request.deltaX / steps, deltaY: request.deltaY / steps,
      });
      if (step + 1 < steps) await pauseBrowserInput(50, signal);
    }
  }, signal, validate, undefined, true);
}

async function pauseBrowserInput(ms: number, signal?: AbortSignal): Promise<void> {
  try { await delay(ms, undefined, { signal }); }
  catch (error) {
    if (signal?.aborted) throw new BrowserPageError('OPERATION_ABORTED', 'Browser operation was aborted.');
    throw error;
  }
}

export async function dragBrowserVisual(browserId: string, request: VisualDragRequest, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
  await runPageInput(browserId, async (send) => {
    const { record } = requireVisualSnapshot(browserId, request.snapshotId);
    const from = imagePointToViewport(record, request.from.x, request.from.y);
    const to = imagePointToViewport(record, request.to.x, request.to.y);
    let lastPoint = from;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    try {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 16; step += 1) {
        const ratio = 1 - Math.pow(1 - step / 16, 3);
        const point = {
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
        };
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', ...point, button: 'left', buttons: 1,
        });
        lastPoint = point;
        await pauseBrowserInput(16, signal);
      }
      await pauseBrowserInput(100, signal);
    } finally {
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...lastPoint, button: 'left', buttons: 0, clickCount: 1 });
    }
  }, signal, validate, undefined, true);
}

const MOUSE_BUTTON_MASKS = { left: 1, right: 2, middle: 4 } as const;
const MODIFIER_MASKS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
const DRAG_PATH_STEP_PX = 6;
const DRAG_PATH_MAX_MOVES = 4000;
const DRAG_PATH_MS_PER_MOVE = 8;
const DRAG_PATH_DEFAULT_MAX_MS = 5000;

export async function dragPathBrowserVisual(browserId: string, request: VisualDragPathRequest, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
  await runPageInput(browserId, async (send) => {
    const { record } = requireVisualSnapshot(browserId, request.snapshotId);
    const points = request.points.map(point => imagePointToViewport(record, point.x, point.y));
    const lengths = points.slice(1).map((to, index) => Math.hypot(to.x - points[index]!.x, to.y - points[index]!.y));
    const wanted = lengths.map(length => Math.max(1, Math.ceil(length / DRAG_PATH_STEP_PX)));
    const total = wanted.reduce((sum, count) => sum + count, 0);
    const extra = total - wanted.length;
    const budget = Math.max(0, DRAG_PATH_MAX_MOVES - wanted.length);
    const steps = total <= DRAG_PATH_MAX_MOVES ? wanted : wanted.map(count => 1 + Math.floor((count - 1) * budget / extra));
    const moves = steps.reduce((sum, count) => sum + count, 0);
    const duration = request.durationMs ?? Math.min(DRAG_PATH_DEFAULT_MAX_MS, moves * DRAG_PATH_MS_PER_MOVE);
    const button = request.button ?? 'left';
    const buttons = MOUSE_BUTTON_MASKS[button];
    const mask = (request.modifiers ?? []).reduce((sum, key) => sum | MODIFIER_MASKS[key], 0);
    const modifiers = mask === 0 ? {} : { modifiers: mask };
    const first = points[0]!;
    let lastPoint = first;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first, ...modifiers });
    try {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...first, button, buttons, clickCount: 1, ...modifiers });
      const started = Date.now();
      let sent = 0;
      for (const [index, count] of steps.entries()) {
        const from = points[index]!, to = points[index + 1]!;
        for (let step = 1; step <= count; step += 1) {
          const point = { x: from.x + (to.x - from.x) * step / count, y: from.y + (to.y - from.y) * step / count };
          sent += 1;
          const wait = started + duration * sent / moves - Date.now();
          if (wait >= 1) await pauseBrowserInput(Math.round(wait), signal);
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button, buttons, ...modifiers });
          lastPoint = point;
        }
      }
      await pauseBrowserInput(100, signal);
    } finally {
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...lastPoint, button, buttons: 0, clickCount: 1, ...modifiers });
    }
  }, signal, validate, undefined, true);
}

export async function typeBrowserVisual(browserId: string, request: VisualTypeRequest, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
  await runPageInput(browserId, async (send) => {
    if (request.replace === true) await dispatchBrowserKeys(send, ['ControlOrMeta', 'A']);
    if (request.text === '' && request.replace === true) await dispatchBrowserKeys(send, ['Backspace']);
    else if (request.text !== '') await send('Input.insertText', { text: request.text });
  }, signal, validate);
}

export async function pressBrowserVisual(browserId: string, request: VisualKeyRequest, signal?: AbortSignal, validate?: () => Promise<void>): Promise<void> {
  await runPageInput(browserId, (send) => dispatchBrowserKeys(send, request.keys), signal, validate);
}

function elementSnapshotCode(snapshotId: string, options: { scope: 'viewport' | 'document'; filter?: { role?: string; text?: string } }): string {
  return `(() => {
    const snapshotId = ${JSON.stringify(snapshotId)};
    const limit = ${MAX_ELEMENT_SNAPSHOT_ITEMS};
    const options = ${JSON.stringify(options)};
    let scanned = 0;
    let scanTruncated = false;
    const selector = 'a[href],button,input,select,textarea,[role],[contenteditable=""],[contenteditable="true"],[tabindex],[onclick]';
    const candidates = [];
    const seen = new Set();
    const deadline = performance.now() + 100;
    const roots = [document];
    while (roots.length > 0 && !scanTruncated) {
      const walker = document.createTreeWalker(roots.pop(), 1);
      let element;
      while ((element = walker.nextNode()) !== null) {
        if (++scanned > 10000 || performance.now() >= deadline) { scanTruncated = true; break; }
        if ((element.matches(selector) || (element.children.length === 0 && getComputedStyle(element).cursor === 'pointer')) && !seen.has(element)) {
          seen.add(element);
          candidates.push(element);
        }
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const transparency = new Map();
    const transparent = (node) => {
      if (!node) return false;
      if (transparency.has(node)) return transparency.get(node);
      const value = Number(getComputedStyle(node).opacity) === 0 || transparent(node.parentElement || node.getRootNode?.()?.host);
      transparency.set(node, value);
      return value;
    };
    const rendered = (element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (transparent(element)) return false;
      const rects = element.getClientRects();
      return rects.length > 0;
    };
    const { isSensitive, textOf, roleOf, nameOf } = (${browserElementSemantics.toString()})(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_TOKENS)});
    const map = new Map();
    const elements = [];
    for (const element of candidates) {
      if (performance.now() >= deadline) { scanTruncated = true; break; }
      if (!rendered(element)) continue;
      const rect = element.getBoundingClientRect();
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      const role = roleOf(element);
      const sensitive = isSensitive(element);
      const name = nameOf(element).slice(0, 500);
      const text = sensitive ? '' : textOf(element).slice(0, 1000);
      if (options.scope === 'viewport' && !inViewport) continue;
      if (options.filter?.role && role !== options.filter.role) continue;
      if (options.filter?.text && !name.includes(options.filter.text) && !text.includes(options.filter.text)) continue;
      if (elements.length >= limit) { scanTruncated = true; break; }
      const ref = 'e' + (elements.length + 1);
      map.set(ref, element);
      const item = {
        ref,
        role, name, text: text || undefined,
        value: !sensitive && typeof element.value === 'string' ? element.value.slice(0, 1000) : undefined,
        disabled: 'disabled' in element ? Boolean(element.disabled) || element.matches(':disabled') : undefined,
        checked: 'checked' in element ? Boolean(element.checked) : undefined,
        selected: 'selected' in element ? Boolean(element.selected) : undefined,
        expanded: element.getAttribute('aria-expanded') === null ? undefined : element.getAttribute('aria-expanded') === 'true',
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
      for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key];
      elements.push(item);
    }
    globalThis.__kimiBrowserElementState = { snapshotId, elements: map };
    return { snapshotId, elements, scope: options.scope, scanTruncated, truncated: scanTruncated };
  })()`;
}

export async function captureBrowserElements(browserId: string, options: { scope: 'viewport' | 'document'; filter?: { role?: string; text?: string } } = { scope: 'document' }): Promise<BrowserElementsSnapshot> {
  const page = requirePage(browserId);
  const snapshotId = `elements-${randomUUID()}`;
  const result = await isolated<BrowserElementsSnapshot>(page.webContents, elementSnapshotCode(snapshotId, options));
  const current = getBrowserPage(browserId);
  if (current?.webContents !== page.webContents || current.generation !== page.generation) throw new BrowserPageError('PAGE_NOT_READY', 'Browser page changed while reading elements.');
  if (result === null || result.snapshotId !== snapshotId || !Array.isArray(result.elements)) {
    throw new BrowserPageError('INTERNAL_ERROR', 'Browser element snapshot returned an invalid result.');
  }
  return result;
}

const RECEIPT_CROP_WIDTH = 480;
const RECEIPT_CROP_HEIGHT = 300;
const RECEIPT_SCAN_LIMIT = 30000;

export interface ReceiptFrameRequest {
  mode: 'pointer' | 'keyboard' | 'target';
  point?: { x: number; y: number };
  target?: { snapshotId: string; ref: string };
}

export function receiptFrameCode(request: ReceiptFrameRequest): string {
  return `(() => {
    const request = ${JSON.stringify(request)};
    const { isSensitive } = (${browserElementSemantics.toString()})(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_TOKENS)});
    let element = request.target ? ${ELEMENT_STATE_ENTRIES}.find(entry => entry?.snapshotId === request.target.snapshotId)?.elements?.get(request.target.ref) : null;
    if (!element?.isConnected) element = null;
    if (!element && request.mode === 'keyboard') {
      element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      if (element === document.body || element === document.documentElement) element = null;
    }
    if (element && isSensitive(element)) return null;
    const visual = globalThis.visualViewport, scale = visual?.scale || 1;
    const offsetX = visual?.offsetLeft || 0, offsetY = visual?.offsetTop || 0;
    const viewWidth = (visual?.width || innerWidth) * scale, viewHeight = (visual?.height || innerHeight) * scale;
    const rect = element ? element.getBoundingClientRect() : null;
    const box = rect && rect.width > 0 && rect.height > 0
      ? { x: (rect.x - offsetX) * scale, y: (rect.y - offsetY) * scale, width: rect.width * scale, height: rect.height * scale }
      : null;
    const point = request.point
      ? (request.target
        ? { x: (request.point.x - offsetX) * scale, y: (request.point.y - offsetY) * scale }
        : { x: request.point.x * scale, y: request.point.y * scale })
      : undefined;
    const center = point ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null);
    if (!center || !(viewWidth > 0) || !(viewHeight > 0)) return null;
    const width = Math.min(${RECEIPT_CROP_WIDTH}, viewWidth), height = Math.min(${RECEIPT_CROP_HEIGHT}, viewHeight);
    const crop = {
      x: Math.min(Math.max(0, center.x - width / 2), viewWidth - width),
      y: Math.min(Math.max(0, center.y - height / 2), viewHeight - height),
      width, height,
    };
    const region = { x: crop.x / scale + offsetX, y: crop.y / scale + offsetY, width: crop.width / scale, height: crop.height / scale };
    let scanned = 0;
    const shown = (node, view) => {
      const box = node.getBoundingClientRect();
      const left = Math.max(box.left + view.x, view.left, region.x), right = Math.min(box.right + view.x, view.right, region.x + region.width);
      const top = Math.max(box.top + view.y, view.top, region.y), bottom = Math.min(box.bottom + view.y, view.bottom, region.y + region.height);
      return box.width > 0 && box.height > 0 && left < right && top < bottom ? box : null;
    };
    const inside = (node, box, view) => {
      let content = null;
      try { content = node.contentDocument; } catch {}
      if (!content || !(Math.abs(box.width - node.offsetWidth) <= 1 && Math.abs(box.height - node.offsetHeight) <= 1)) return null;
      const style = getComputedStyle(node), padding = side => parseFloat(style['padding' + side]) || 0;
      const x = box.left + view.x + node.clientLeft + padding('Left'), y = box.top + view.y + node.clientTop + padding('Top');
      const right = x + node.clientWidth - padding('Left') - padding('Right'), bottom = y + node.clientHeight - padding('Top') - padding('Bottom');
      if (![x, y, right, bottom].every(Number.isFinite)) return null;
      return { content, view: { x, y, left: Math.max(view.left, x), top: Math.max(view.top, y), right: Math.min(view.right, right), bottom: Math.min(view.bottom, bottom) } };
    };
    const exposes = (root, view) => {
      for (const node of root.querySelectorAll('*')) {
        if (++scanned > ${RECEIPT_SCAN_LIMIT}) return true;
        if ((node.matches('input, textarea') ? node.value : node.hasAttribute('autocomplete')) && isSensitive(node) && shown(node, view)) return true;
        if (node.shadowRoot && exposes(node.shadowRoot, view)) return true;
        if (!node.matches('iframe, frame, object, embed')) continue;
        const box = shown(node, view);
        if (!box || box.width <= 1 || box.height <= 1 || ['hidden', 'collapse'].includes(getComputedStyle(node).visibility)) continue;
        const frame = inside(node, box, view);
        if (!frame || exposes(frame.content, frame.view)) return true;
      }
      return false;
    };
    if (exposes(document, { x: 0, y: 0, left: 0, top: 0, right: innerWidth, bottom: innerHeight })) return null;
    return { viewport: { width: viewWidth, height: viewHeight }, crop, point, box };
  })()`;
}

export function elementPresentationCode(target: { snapshotId: string; ref: string }): string {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const element = ${ELEMENT_STATE_ENTRIES}.find(entry => entry?.snapshotId === target.snapshotId)?.elements?.get(target.ref);
    if (!element || !element.isConnected) return null;
    const box = element.getBoundingClientRect(), viewport = globalThis.visualViewport, scale = viewport?.scale || 1;
    if (!(box.width > 0) || !(box.height > 0)) return null;
    const role = (element.getAttribute?.('role') || '').toLowerCase();
    const field = element.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
      || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role)
      || Boolean(element.querySelector?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]'));
    const button = element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type);
    const label = [
      element.getAttribute?.('aria-label'), element.labels?.[0]?.innerText, button ? element.value : '',
      element.getAttribute?.('placeholder'), element.getAttribute?.('alt'), element.getAttribute?.('title'), field ? '' : element.innerText,
    ].find(text => typeof text === 'string' && text.trim() !== '') ?? '';
    return {
      label: label.replace(/\\s+/g, ' ').trim().slice(0, 80),
      rect: { x: (box.x - (viewport?.offsetLeft || 0)) * scale, y: (box.y - (viewport?.offsetTop || 0)) * scale, width: box.width * scale, height: box.height * scale },
    };
  })()`;
}

export function elementCommandCode(request: ElementRequest, phase: 'prepare' | 'verify' | 'guard' | 'change' = 'prepare', input?: 'keyboard' | { x: number; y: number }, deadline?: number): string {
  const payload = JSON.stringify(request);
  return `(() => {
    const request = ${payload};
    const deadline = ${JSON.stringify(deadline ?? null)};
    const expired = () => deadline !== null && Date.now() > deadline;
    const abandoned = { ok: false, code: 'ACTION_UNDETERMINED', message: 'The action was abandoned after the page did not respond in time.' };
    const elements = ${ELEMENT_STATE_ENTRIES}.find(entry => entry?.snapshotId === request.snapshotId)?.elements;
    if (!elements) {
      return { ok: false, code: 'STALE_ELEMENT', message: 'The element snapshot is stale.' };
    }
    const element = elements.get(request.ref);
    if (!element || !element.isConnected) {
      return { ok: false, code: 'STALE_ELEMENT', message: 'The element is no longer connected.' };
    }
    if (${JSON.stringify(phase)} === 'verify') {
      return element.checked === request.checked
        ? { ok: true }
        : { ok: false, code: 'ELEMENT_NOT_INTERACTABLE', message: 'The control did not reach the requested checked state.' };
    }
    if (${JSON.stringify(phase)} === 'change') {
      if (expired()) return abandoned;
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      const selected = element.options?.[element.selectedIndex];
      const kept = request.value !== undefined ? selected?.value === request.value
        : request.label !== undefined ? selected?.label === request.label || selected?.text === request.label
        : element.selectedIndex === request.index;
      return kept ? { ok: true } : { ok: false, code: 'ELEMENT_NOT_INTERACTABLE', message: 'The page changed the selection back after the option was selected.' };
    }
    if ('disabled' in element && (element.disabled || element.matches(':disabled'))) {
      return { ok: false, code: 'ELEMENT_NOT_INTERACTABLE', message: 'The element is disabled.' };
    }
    const belongsToTarget = (node) => {
      while (node) {
        if (node === element) return true;
        node = node.parentElement || node.getRootNode()?.host;
      }
      return false;
    };
    if (${JSON.stringify(phase)} === 'guard') {
      const input = ${JSON.stringify(input)};
      if (input === 'keyboard') {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        const textOperation = request.operation === 'page.element.fill' || request.operation === 'page.element.type_text';
        if (active !== element || (textOperation && element.readOnly)) {
          return { ok: false, code: 'ELEMENT_NOT_INTERACTABLE', message: 'The original element no longer has editable focus.' };
        }
      } else {
        let hit = document.elementFromPoint(input.x, input.y);
        while (hit?.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(input.x, input.y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        if (!belongsToTarget(hit)) return { ok: false, code: 'ELEMENT_NOT_INTERACTABLE', message: 'The pointer no longer reaches the original element.' };
      }
      return { ok: true };
    }
    const hitAt = (x, y) => {
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      return hit;
    };
    const describeOccluder = (node) => {
      try {
        if (!node || typeof node.tagName !== 'string') return null;
        const { isSensitive, roleOf, nameOf } = (${browserElementSemantics.toString()})(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_TOKENS)});
        const quote = (value, limit) => {
          const text = String(value).replace(/\\s+/g, ' ').trim();
          return JSON.stringify(text.length > limit ? text.slice(0, limit - 1) + '\\u2026' : text);
        };
        const parts = [node.tagName.toLowerCase()];
        const id = node.getAttribute('id');
        if (id) parts.push('id=' + quote(id, 40));
        const className = node.getAttribute('class');
        if (className && className.trim()) parts.push('class=' + quote(className.trim().split(/\\s+/).slice(0, 3).join(' '), 60));
        const role = roleOf(node);
        if (role && role !== 'generic') parts.push('role=' + quote(role, 30));
        const fieldLike = /^(input|textarea|select)$/i.test(node.tagName) || node.isContentEditable;
        const name = isSensitive(node) ? '' : fieldLike ? (node.getAttribute('aria-label') || node.getAttribute('title') || '') : nameOf(node);
        const label = '<' + parts.join(' ') + '>';
        return name && name.trim() ? label + ' ' + quote(name, 40) : label;
      } catch {
        return null;
      }
    };
    const interactionPoint = () => {
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (right <= left || bottom <= top) return { point: null, visible: false };
      const fractions = [[0.5, 0.5], [0.5, 0.15], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
      let occluder = null;
      for (const [fx, fy] of fractions) {
        const point = { x: left + (right - left) * fx, y: top + (bottom - top) * fy };
        const hit = hitAt(point.x, point.y);
        if (belongsToTarget(hit)) return { point, visible: true };
        if (!occluder && hit) occluder = hit;
      }
      return { point: null, visible: true, occluder };
    };
    const focusTarget = () => {
      if (typeof element.focus !== 'function') return false;
      element.focus({ preventScroll: true });
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active === element;
    };
    const notInteractable = (message) => ({ ok: false, changed: true, code: 'ELEMENT_NOT_INTERACTABLE', message });
    const reach = request.operation === 'page.element.scroll_into_view' ? null : interactionPoint();
    const point = reach?.point ?? null;
    if (reach && point === null) {
      const covering = reach.visible ? describeOccluder(reach.occluder) : null;
      return notInteractable(covering ? 'The element is covered by ' + covering + ' at its visible bounds.' : 'The element cannot be reached at its visible bounds.');
    }
    switch (request.operation) {
      case 'page.element.click':
      case 'page.element.hover': {
        return { ok: true, point };
      }
      case 'page.element.fill':
      case 'page.element.type_text': {
        const textInputTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
        const editable = (element instanceof HTMLInputElement && textInputTypes.has(element.type)) || element instanceof HTMLTextAreaElement || element.isContentEditable;
        if (!editable) return { ok: false, code: 'UNSUPPORTED_ELEMENT', message: 'The element does not accept text.' };
        if (element.readOnly || !focusTarget()) return notInteractable('The element cannot receive text input.');
        return { ok: true };
      }
      case 'page.element.press_key':
        return focusTarget() ? { ok: true } : notInteractable('The element could not receive keyboard focus.');
      case 'page.element.select_option': {
        if (!(element instanceof HTMLSelectElement)) return { ok: false, code: 'UNSUPPORTED_ELEMENT', message: 'The element is not a select.' };
        let option;
        if (request.value !== undefined) option = Array.from(element.options).find((item) => item.value === request.value);
        else if (request.label !== undefined) option = Array.from(element.options).find((item) => item.label === request.label || item.text === request.label);
        else option = element.options.item(request.index);
        if (!option) return { ok: false, code: 'ELEMENT_NOT_FOUND', message: 'The select option was not found.' };
        if (option.disabled || option.closest('optgroup')?.disabled) return notInteractable('The select option is disabled.');
        if (expired()) return abandoned;
        element.selectedIndex = option.index;
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        return element.options[element.selectedIndex] === option ? { ok: true } : notInteractable('The select option could not be selected.');
      }
      case 'page.element.set_checked':
        if (!(element instanceof HTMLInputElement) || (element.type !== 'checkbox' && element.type !== 'radio')) {
          return { ok: false, code: 'UNSUPPORTED_ELEMENT', message: 'The element is not checkable.' };
        }
        return { ok: true, point, needsClick: element.checked !== request.checked };
      case 'page.element.scroll_into_view':
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return { ok: true };
      default:
        return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown element operation.' };
    }
  })()`;
}

async function sideEffectPhase(webContents: WebContents, request: ElementRequest, phase: 'prepare' | 'verify' | 'change'): Promise<ElementCommandResult> {
  try {
    return await isolated<ElementCommandResult>(webContents, elementCommandCode(request, phase, undefined, Date.now() + BROWSER_PAGE_SCRIPT_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof BrowserPageError && error.message === SCRIPT_TIMEOUT_MESSAGE) throw new BrowserPageError('ACTION_UNDETERMINED', ACTION_UNDETERMINED_MESSAGE);
    throw error;
  }
}

export async function runBrowserElementAction(browserId: string, request: ElementRequest, signal?: AbortSignal, validate?: () => Promise<void>, onTarget?: (pending: Promise<BrowserActivityTarget | null>) => void): Promise<void> {
  await runPageInput(browserId, async (send, check) => {
    await check();
    const page = requirePage(browserId);
    const result = request.operation === 'page.element.select_option'
      ? await sideEffectPhase(page.webContents, request, 'prepare')
      : await isolated<ElementCommandResult>(page.webContents, elementCommandCode(request));
    if (request.operation === 'page.element.select_option' || request.operation === 'page.element.scroll_into_view') await check();
    if (!result.ok) {
      throw new BrowserPageError(result.code ?? 'INTERNAL_ERROR', result.message ?? 'Element operation failed.');
    }
    if (request.operation === 'page.element.select_option') {
      const changed = await sideEffectPhase(page.webContents, request, 'change');
      await check();
      if (!changed.ok) throw new BrowserPageError(changed.code ?? 'INTERNAL_ERROR', changed.message ?? 'Element operation failed.');
    }
    if (request.operation === 'page.element.select_option' && browserReceiptWanted()) {
      await captureRenderedReceipt(page.webContents, receiptFrameCode({ mode: 'target', target: { snapshotId: request.snapshotId, ref: request.ref } }));
    }
    onTarget?.(isolated<unknown>(page.webContents, elementPresentationCode(request)).then((shown): BrowserActivityTarget | null => {
      const target = shown as { label?: unknown; rect?: Record<string, unknown> } | null;
      const rect = target?.rect;
      if (typeof target?.label !== 'string' || !rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))) return null;
      return { label: target.label, rect: rect as { x: number; y: number; width: number; height: number } };
    }));
    if (request.operation === 'page.element.click' || request.operation === 'page.element.hover') {
      if (result.point === undefined) throw new BrowserPageError('ELEMENT_NOT_INTERACTABLE', 'The element has no interaction point.');
      const point = { x: result.point.x * page.inputScale, y: result.point.y * page.inputScale };
      if (request.operation === 'page.element.click') await sendClick(send, point, 'left', 1);
      else await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    } else if (request.operation === 'page.element.fill' || request.operation === 'page.element.type_text') {
      if (request.operation === 'page.element.fill') await dispatchBrowserKeys(send, ['ControlOrMeta', 'A']);
      if (request.text === '' && request.operation === 'page.element.fill') await dispatchBrowserKeys(send, ['Backspace']);
      else if (request.text !== '') await send('Input.insertText', { text: request.text });
    } else if (request.operation === 'page.element.press_key') {
      await dispatchBrowserKeys(send, request.keys);
    } else if (request.operation === 'page.element.set_checked' && result.needsClick) {
      if (result.point === undefined) throw new BrowserPageError('ELEMENT_NOT_INTERACTABLE', 'The control has no interaction point.');
      await sendClick(send, { x: result.point.x * page.inputScale, y: result.point.y * page.inputScale }, 'left', 1);
      const verified = await sideEffectPhase(page.webContents, request, 'verify');
      if (!verified.ok) throw new BrowserPageError(verified.code ?? 'INTERNAL_ERROR', verified.message ?? 'Checked state could not be verified.');
    }
  }, signal, validate, async (method, params) => {
    const page = requirePage(browserId);
    const input = method === 'Input.dispatchMouseEvent'
      ? { x: Number(params?.['x']) / page.inputScale, y: Number(params?.['y']) / page.inputScale }
      : 'keyboard';
    const result = await isolated<ElementCommandResult>(page.webContents, elementCommandCode(request, 'guard', input));
    if (!result.ok) throw new BrowserPageError(result.code ?? 'INTERNAL_ERROR', result.message ?? 'The original element changed before input.');
  }, false, { snapshotId: request.snapshotId, ref: request.ref });
}

export async function currentBrowserElementSnapshot(browserId: string): Promise<string | undefined> {
  return isolated(requirePage(browserId).webContents, 'globalThis.__kimiBrowserElementState?.snapshotId');
}
