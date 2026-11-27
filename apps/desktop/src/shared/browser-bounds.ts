import { Type, type Static } from 'typebox';
import { BrowserNonnegativeNumberSchema } from './browser-schema';
import { defineBrowserValidator } from './browser-validator';

export const BrowserBoundsSchema = Type.Object({ x: BrowserNonnegativeNumberSchema, y: BrowserNonnegativeNumberSchema, width: BrowserNonnegativeNumberSchema, height: BrowserNonnegativeNumberSchema });
export type BrowserBounds = Static<typeof BrowserBoundsSchema>;

export const browserValidators = {
  BrowserBoundsSchema: defineBrowserValidator(BrowserBoundsSchema),
};

export function asBrowserBounds(value: unknown): BrowserBounds | null {
  const bounds = browserValidators.BrowserBoundsSchema.Parse(value);
  return bounds === null ? null : { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
}
