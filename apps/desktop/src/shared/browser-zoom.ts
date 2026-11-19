import { defineBrowserValidator } from './browser-validator';
import { Type } from 'typebox';
export const BROWSER_ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

export const BrowserZoomFactorSchema = Type.Number({ minimum: BROWSER_ZOOM_STEPS[0], maximum: BROWSER_ZOOM_STEPS[BROWSER_ZOOM_STEPS.length - 1] });

export function isBrowserZoomFactor(value: unknown): value is number {
  return browserValidators.BrowserZoomFactorSchema.Check(value);
}

export const browserValidators = {
  BrowserZoomFactorSchema: defineBrowserValidator(BrowserZoomFactorSchema),
};
