import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { parseBrowserCapture, type BrowserCapture } from '@moonshot-ai/app-core/browser-reference';

export const ANNOTATION_DETAIL_LABELS = ['annotation', 'classes', 'geometry', 'semantics', 'data', 'source', 'pageTitle', 'url', 'capturedAt', 'viewport', 'width', 'height', 'zoom', 'pixelRatio', 'size', 'position', 'copy', 'insert', 'more', 'less', 'items', 'item', 'base', 'interaction', 'responsive', 'theme', 'truncated', 'copied', 'copyFailed'] as const;
export const BrowserAnnotationDetailLabelsSchema = Type.Record(Type.Enum(ANNOTATION_DETAIL_LABELS), Type.String({ maxLength: 256 }));
const DetailsInput = Type.Object({ capture: Type.Unknown(), labels: BrowserAnnotationDetailLabelsSchema, locale: Type.String({ pattern: '^[a-zA-Z-]{2,32}$' }) });
export type BrowserAnnotationDetails = Omit<Static<typeof DetailsInput>, 'capture'> & { capture: BrowserCapture };

export function parseBrowserAnnotationDetails(value: unknown): BrowserAnnotationDetails | null {
  const details = browserValidators.DetailsInput.Parse(value);
  if (details === null) return null;
  const capture = parseBrowserCapture(details.capture);
  if (capture === null) return null;
  try { Intl.getCanonicalLocales(details.locale); } catch { return null; }
  const labels = browserValidators.BrowserAnnotationDetailLabelsSchema.Parse(details.labels);
  return labels === null ? null : { capture, locale: details.locale, labels };
}

export const browserValidators = {
  DetailsInput: defineBrowserValidator(DetailsInput),
  BrowserAnnotationDetailLabelsSchema: defineBrowserValidator(BrowserAnnotationDetailLabelsSchema),
};
