import { v4 as randomUUID } from 'uuid';
import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserZoomFactorSchema } from './browser-zoom';
import { BrowserDeviceStateSchema } from './browser-device';
import { BrowserIdSchema, BrowserNonnegativeNumberSchema } from './browser-schema';

export const BrowserBoundsSchema = Type.Object({ x: BrowserNonnegativeNumberSchema, y: BrowserNonnegativeNumberSchema, width: BrowserNonnegativeNumberSchema, height: BrowserNonnegativeNumberSchema });
export type BrowserBounds = Static<typeof BrowserBoundsSchema>;
export type BrowserId = Static<typeof BrowserIdSchema>;

export function createBrowserId(): BrowserId {
  return `browser-${randomUUID()}`;
}

export const BROWSER_STATE_URL_MAX = 4_096;
export const BROWSER_STATE_TITLE_MAX = 512;
export const BROWSER_STATE_FAVICON_MAX = 128 * 1_024;

export const BrowserStateSchema = Type.Object({
  url: Type.String({ maxLength: BROWSER_STATE_URL_MAX }), urlTruncated: Type.Optional(Type.Boolean()),
  title: Type.String({ maxLength: BROWSER_STATE_TITLE_MAX }), favicon: Type.Optional(Type.String({ minLength: 1, maxLength: BROWSER_STATE_FAVICON_MAX })),
  zoomFactor: Type.Optional(BrowserZoomFactorSchema), emulateFocus: Type.Optional(Type.Boolean()), device: Type.Optional(BrowserDeviceStateSchema),
  muted: Type.Optional(Type.Boolean()), renderable: Type.Optional(Type.Boolean()),
  loading: Type.Boolean(), canGoBack: Type.Boolean(), canGoForward: Type.Boolean(), error: Type.Optional(Type.String()),
});
export type BrowserState = Static<typeof BrowserStateSchema>;
export const BrowserStateEventSchema = Type.Object({ browserId: BrowserIdSchema, state: BrowserStateSchema });
export type BrowserStateEvent = Static<typeof BrowserStateEventSchema>;

export const EMPTY_BROWSER_STATE: BrowserState = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };

export function asBrowserFavicon(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > BROWSER_STATE_FAVICON_MAX
  ) {
    return null;
  }
  if (value.startsWith('data:image/')) return value;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function isBrowserState(value: unknown): value is BrowserState {
  return browserValidators.BrowserStateSchema.Check(value) && (value.favicon === undefined || asBrowserFavicon(value.favicon) !== null);
}

export function asBrowserId(value: unknown): BrowserId | null {
  return browserValidators.BrowserIdSchema.Check(value) ? value : null;
}

export function isBrowserStateEvent(value: unknown): value is BrowserStateEvent {
  return browserValidators.BrowserStateEventSchema.Check(value) && isBrowserState(value.state);
}

export function asBrowserBounds(value: unknown): BrowserBounds | null {
  const bounds = browserValidators.BrowserBoundsSchema.Parse(value);
  return bounds === null ? null : { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
}

export const BrowserTabCommandSchema = Type.Object({ browserId: BrowserIdSchema, action: Type.Enum(['copy-url', 'open-external', 'mute', 'unmute']) }, { additionalProperties: false });
export type BrowserTabCommand = Static<typeof BrowserTabCommandSchema>;
export function isBrowserTabCommand(value: unknown): value is BrowserTabCommand {
  return browserValidators.BrowserTabCommandSchema.Check(value);
}

export const BrowserFindRequestSchema = Type.Object({ browserId: BrowserIdSchema, text: Type.String({ maxLength: 4096 }), forward: Type.Boolean(), findNext: Type.Boolean() });

export const BrowserFocusEmulationRequestSchema = Type.Object({ browserId: BrowserIdSchema, enabled: Type.Boolean() });
export function asBrowserFocusEmulationRequest(value: unknown): Static<typeof BrowserFocusEmulationRequestSchema> | null {
  return browserValidators.focusEmulation.Parse(value);
}

export const BrowserNavigateRequestSchema = Type.Object({ browserId: BrowserIdSchema, address: Type.String({ minLength: 1, maxLength: BROWSER_STATE_URL_MAX }), urlSuffix: Type.Optional(Type.String({ maxLength: BROWSER_STATE_URL_MAX })) });
export function asBrowserNavigateRequest(value: unknown): Static<typeof BrowserNavigateRequestSchema> | null {
  const request = browserValidators.navigate.Parse(value);
  return request !== null && request.address.trim() !== '' ? request : null;
}

export const BrowserCloneRequestSchema = Type.Object({ sourceId: BrowserIdSchema, targetId: BrowserIdSchema });
export function asBrowserCloneRequest(value: unknown): Static<typeof BrowserCloneRequestSchema> | null {
  const request = browserValidators.clone.Parse(value);
  return request !== null && request.sourceId !== request.targetId ? request : null;
}

export const BrowserZoomRequestSchema = Type.Object({ browserId: BrowserIdSchema, action: Type.Enum(['in', 'out', 'reset']) });
export function asBrowserZoomRequest(value: unknown): Static<typeof BrowserZoomRequestSchema> | null {
  return browserValidators.zoom.Parse(value);
}

export const BrowserBoundsRequestSchema = Type.Object({ browserId: BrowserIdSchema, bounds: BrowserBoundsSchema });
export function asBrowserBoundsRequest(value: unknown): { browserId: BrowserId; bounds: BrowserBounds } | null {
  const request = browserValidators.bounds.Parse(value);
  const bounds = request === null ? null : asBrowserBounds(request.bounds);
  return request === null || bounds === null ? null : { browserId: request.browserId, bounds };
}

export const BrowserVisibilityRequestSchema = Type.Object({ browserId: BrowserIdSchema, visible: Type.Boolean() });
export function asBrowserVisibilityRequest(value: unknown): Static<typeof BrowserVisibilityRequestSchema> | null {
  return browserValidators.visibility.Parse(value);
}

export const BrowserOcclusionRequestSchema = Type.Object({ browserId: BrowserIdSchema, occluded: Type.Boolean() });
export function asBrowserOcclusionRequest(value: unknown): Static<typeof BrowserOcclusionRequestSchema> | null {
  return browserValidators.occlusion.Parse(value);
}

const OpenLink = Type.Object({ browserId: BrowserIdSchema, url: Type.String({ maxLength: 32768 }), background: Type.Optional(Type.Boolean()) });

export const browserValidators = {
  focusEmulation: defineBrowserValidator(BrowserFocusEmulationRequestSchema),
  navigate: defineBrowserValidator(BrowserNavigateRequestSchema),
  clone: defineBrowserValidator(BrowserCloneRequestSchema),
  openLink: defineBrowserValidator(OpenLink),
  find: defineBrowserValidator(BrowserFindRequestSchema),
  zoom: defineBrowserValidator(BrowserZoomRequestSchema),
  bounds: defineBrowserValidator(BrowserBoundsRequestSchema),
  visibility: defineBrowserValidator(BrowserVisibilityRequestSchema),
  occlusion: defineBrowserValidator(BrowserOcclusionRequestSchema),
  BrowserStateSchema: defineBrowserValidator(BrowserStateSchema),
  BrowserIdSchema: defineBrowserValidator(BrowserIdSchema),
  BrowserStateEventSchema: defineBrowserValidator(BrowserStateEventSchema),
  BrowserBoundsSchema: defineBrowserValidator(BrowserBoundsSchema),
  BrowserTabCommandSchema: defineBrowserValidator(BrowserTabCommandSchema),
};
