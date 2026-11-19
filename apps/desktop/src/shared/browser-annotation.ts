import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserIdSchema } from './browser-schema';

const ContextTargetId = Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' });
import type { BrowserCapture, BrowserCaptureRect } from '@moonshot-ai/app-core/browser-reference';

const StyleValue = Type.String({ maxLength: 512 });
export const BrowserAnnotationPickOptionsSchema = Type.Object({
  borderColor: StyleValue, ancestorColor: StyleValue, fillColor: StyleValue, borderRadius: StyleValue,
  transitionDuration: StyleValue, transitionTiming: StyleValue, labelColor: StyleValue, labelFont: StyleValue,
  labelFontSize: StyleValue, labelPadding: StyleValue, labelGap: StyleValue, labelMaxWidth: StyleValue, regionLabel: StyleValue,
  contextTargetId: Type.Optional(ContextTargetId),
  ordinal: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
});
export type BrowserAnnotationPickOptions = Static<typeof BrowserAnnotationPickOptionsSchema>;

const ContextRequest = Type.Object({ browserId: BrowserIdSchema, targetId: ContextTargetId });
export type BrowserAnnotationContextRequest = Static<typeof ContextRequest>;

export interface BrowserAnnotationPickResult {
  capture: BrowserCapture;
  anchor?: BrowserCaptureRect;
  assetId?: string;
  thumbnail?: string;
  size?: number;
}

export interface BrowserAnnotationAsset {
  data: string;
  mimeType: 'image/png';
  name: string;
  size: number;
}

export interface BrowserAnnotationLocation {
  located: boolean;
  browserId?: string;
}

export function browserAnnotationCrop(bounds: BrowserCaptureRect, viewport: { width: number; height: number }, image: { width: number; height: number }): { crop: BrowserCaptureRect; pixels: BrowserCaptureRect } | null {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, viewport.width, viewport.height, image.width, image.height].every(Number.isFinite)) return null;
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(viewport.width, bounds.x + bounds.width);
  const bottom = Math.min(viewport.height, bounds.y + bounds.height);
  if (right <= x || bottom <= y) return null;
  const pixelX = Math.floor(x * image.width / viewport.width);
  const pixelY = Math.floor(y * image.height / viewport.height);
  const pixelRight = Math.min(image.width, Math.ceil(right * image.width / viewport.width));
  const pixelBottom = Math.min(image.height, Math.ceil(bottom * image.height / viewport.height));
  return { crop: { x, y, width: right - x, height: bottom - y }, pixels: { x: pixelX, y: pixelY, width: pixelRight - pixelX, height: pixelBottom - pixelY } };
}

export function asBrowserAnnotationPickOptions(value: unknown): BrowserAnnotationPickOptions | null {
  const options = browserValidators.BrowserAnnotationPickOptionsSchema.Parse(value);
  return options === null ? null : { ...options, contextTargetId: options.contextTargetId, ordinal: options.ordinal };
}

export const BrowserAnnotationPickRequestSchema = Type.Object({ browserId: BrowserIdSchema, options: BrowserAnnotationPickOptionsSchema });
export function asBrowserAnnotationPickRequest(value: unknown): { browserId: Static<typeof BrowserIdSchema>; options: BrowserAnnotationPickOptions } | null {
  const request = browserValidators.pick.Parse(value);
  const options = request === null ? null : asBrowserAnnotationPickOptions(request.options);
  return request === null || options === null ? null : { browserId: request.browserId, options };
}

export const BrowserAnnotationCaptureActionSchema = Type.Enum(['prepare', 'commit', 'cancel']);
export type BrowserAnnotationCaptureAction = Static<typeof BrowserAnnotationCaptureActionSchema>;

export function isBrowserAnnotationCaptureAction(value: unknown): value is BrowserAnnotationCaptureAction {
  return browserValidators.captureAction.Check(value);
}

const ReferenceId = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' });
const Completion = Type.Object({ id: ReferenceId, action: BrowserAnnotationCaptureActionSchema });
const Marker = Type.Object({ id: ReferenceId, ordinal: Type.Integer({ minimum: 1, maximum: 1000000 }), locate: Type.Boolean() });

export const browserValidators = {
  context: defineBrowserValidator(ContextRequest),
  referenceId: defineBrowserValidator(ReferenceId),
  retainedAssets: defineBrowserValidator(Type.Array(ReferenceId, { maxItems: 100000 })),
  completion: defineBrowserValidator(Completion),
  marker: defineBrowserValidator(Marker),
  captureAction: defineBrowserValidator(BrowserAnnotationCaptureActionSchema),
  pick: defineBrowserValidator(BrowserAnnotationPickRequestSchema),
  BrowserAnnotationPickOptionsSchema: defineBrowserValidator(BrowserAnnotationPickOptionsSchema),
};
