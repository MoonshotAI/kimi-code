export interface BrowserReference {
  id: string;
  captureId: string;
  comment?: string;
  includeScreenshot?: boolean;
}

export interface BrowserCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserCaptureTarget =
  | { kind: 'region'; bounds: BrowserCaptureRect }
  | {
      kind: 'element';
      tagName: string;
      attributes?: Record<string, string>;
      attributesTruncated?: boolean;
      role?: string;
      accessibleName?: string;
      text?: string;
      locator?: { xpath?: string; selector?: string; framePath?: string[] };
      bounds: BrowserCaptureRect;
    };

export interface BrowserCapture {
  version: 1;
  id: string;
  bindingId?: string;
  ordinal: number;
  label: string;
  capturedAt: string;
  page: { url: string; title: string };
  target: BrowserCaptureTarget;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    zoomFactor: number;
    devicePixelRatio: number;
  };
  screenshot?: {
    attachmentId: string;
    crop: BrowserCaptureRect;
    pixelWidth: number;
    pixelHeight: number;
  };
}

export function browserCaptureBindingId(capture: BrowserCapture): string {
  return capture.bindingId ?? capture.id;
}

export function isBrowserReferenceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value['length'] <= max;
}

function number(value: unknown, min: number, max = 1_000_000): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || text(value, max);
}

function parseRect(value: unknown): BrowserCaptureRect | null {
  if (!record(value) || !number(value['x'], -1_000_000) || !number(value['y'], -1_000_000) || !number(value['width'], 0.01) || !number(value['height'], 0.01)) return null;
  return { x: value['x'], y: value['y'], width: value['width'], height: value['height'] };
}

function parseTarget(value: unknown): BrowserCaptureTarget | null {
  if (!record(value)) return null;
  const bounds = parseRect(value['bounds']);
  if (bounds === null) return null;
  if (value['kind'] === 'region') return { kind: 'region', bounds };
  if (value['kind'] !== 'element' || !text(value['tagName'], 128) || value['tagName']['length'] === 0 || !optionalText(value['role'], 128) || !optionalText(value['accessibleName'], 2_000) || !optionalText(value['text'], 4_000)) return null;
  let attributes: Record<string, string> | undefined;
  if (value['attributes'] !== undefined) {
    if (!record(value['attributes']) || Object.keys(value['attributes']).length > 128) return null;
    const entries = Object.entries(value['attributes']);
    if (entries.some(([key, entry]) => !/^(id|class|href|target|src|alt|type|name|placeholder|disabled|readonly|data-[a-zA-Z0-9_.:-]+)$/.test(key) || key.length > 128 || !text(entry, 4096))) return null;
    if (entries.reduce((total, [key, entry]) => total + key.length + (entry as string).length, 0) > 32768) return null;
    attributes = Object.fromEntries(entries) as Record<string, string>;
  }
  if (value['attributesTruncated'] !== undefined && typeof value['attributesTruncated'] !== 'boolean') return null;
  let locator: Extract<BrowserCaptureTarget, { kind: 'element' }>['locator'];
  if (value['locator'] !== undefined) {
    if (!record(value['locator']) || !optionalText(value['locator']['selector'], 4_096) || !optionalText(value['locator']['xpath'], 4_096)) return null;
    const framePath = value['locator']['framePath'];
    if (framePath !== undefined && (!Array.isArray(framePath) || framePath.length > 16 || !framePath.every((frame: unknown) => text(frame, 4_096)))) return null;
    locator = { xpath: value['locator']['xpath'], selector: value['locator']['selector'], framePath: framePath === undefined ? undefined : [...framePath] as string[] };
  }
  return { kind: 'element', ...(attributes === undefined ? {} : { attributes }), ...(value['attributesTruncated'] === undefined ? {} : { attributesTruncated: value['attributesTruncated'] }), tagName: value['tagName'], role: value['role'], accessibleName: value['accessibleName'], text: value['text'], locator, bounds };
}

export function parseBrowserReference(value: unknown): BrowserReference | null {
  if (!record(value) || !isBrowserReferenceId(value['id']) || !isBrowserReferenceId(value['captureId']) || !optionalText(value['comment'], 10_000) || (value['includeScreenshot'] !== undefined && typeof value['includeScreenshot'] !== 'boolean')) return null;
  return { id: value['id'], captureId: value['captureId'], comment: value['comment'], includeScreenshot: value['includeScreenshot'] };
}

export function parseBrowserCapture(value: unknown): BrowserCapture | null {
  if (record(value) && value['bindingId'] !== undefined && !isBrowserReferenceId(value['bindingId'])) return null;
  if (!record(value) || value['version'] !== 1 || !isBrowserReferenceId(value['id']) || !number(value['ordinal'], 1) || !Number.isInteger(value['ordinal']) || !text(value['label'], 256) || value['label']['length'] === 0) return null;
  if (!text(value['capturedAt'], 64) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value['capturedAt']) || !Number.isFinite(Date.parse(value['capturedAt']))) return null;
  if (new Date(value['capturedAt']).toISOString() !== value['capturedAt']) return null;
  if (!record(value['page']) || !text(value['page']['url'], 32_768) || !text(value['page']['title'], 1_024)) return null;
  try {
    if (!['http:', 'https:'].includes(new URL(value['page']['url']).protocol)) return null;
  } catch {
    return null;
  }
  const target = parseTarget(value['target']);
  const viewport = value['viewport'];
  if (target === null || !record(viewport) || !number(viewport['width'], 1) || !number(viewport['height'], 1) || !number(viewport['scrollX'], -1_000_000) || !number(viewport['scrollY'], -1_000_000) || !number(viewport['zoomFactor'], 0.01, 64) || !number(viewport['devicePixelRatio'], 0.01, 64)) return null;
  let screenshot: BrowserCapture['screenshot'];
  if (value['screenshot'] !== undefined) {
    const raw = value['screenshot'];
    if (!record(raw) || !isBrowserReferenceId(raw['attachmentId']) || !number(raw['pixelWidth'], 1, 32_768) || !number(raw['pixelHeight'], 1, 32_768) || !Number.isInteger(raw['pixelWidth']) || !Number.isInteger(raw['pixelHeight'])) return null;
    const crop = parseRect(raw['crop']);
    if (crop === null || crop.x < 0 || crop.y < 0 || crop.x + crop.width > viewport['width'] + 1 || crop.y + crop.height > viewport['height'] + 1) return null;
    screenshot = { attachmentId: raw['attachmentId'], crop, pixelWidth: raw['pixelWidth'], pixelHeight: raw['pixelHeight'] };
  }
  return {
    version: 1,
    id: value['id'],
    ...(value['bindingId'] === undefined ? {} : { bindingId: value['bindingId'] as string }),
    ordinal: value['ordinal'],
    label: value['label'],
    capturedAt: value['capturedAt'],
    page: { url: value['page']['url'], title: value['page']['title'] },
    target,
    viewport: { width: viewport['width'], height: viewport['height'], scrollX: viewport['scrollX'], scrollY: viewport['scrollY'], zoomFactor: viewport['zoomFactor'], devicePixelRatio: viewport['devicePixelRatio'] },
    screenshot,
  };
}

export function removedBrowserCaptureBindings(previous: readonly BrowserCapture[], current: readonly BrowserCapture[]): BrowserCapture[] {
  const remaining = new Set(current.map(browserCaptureBindingId));
  const removed = new Map(previous.map((capture) => [browserCaptureBindingId(capture), capture]));
  return [...removed].filter(([id]) => !remaining.has(id)).map(([, capture]) => capture);
}
