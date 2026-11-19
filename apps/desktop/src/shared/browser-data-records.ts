import { Type, type Static } from 'typebox';
import { defineBrowserValidator } from './browser-validator';
import {
  BROWSER_RECORD_FAVICON_MAX,
  BROWSER_RECORD_PATH_MAX,
  BROWSER_RECORD_URL_MAX,
  BrowserDownloadEntrySchema,
  BrowserHistoryEntrySchema,
  type BrowserHistoryEntry,
} from './browser-data';

export const BROWSER_DOWNLOAD_URL_CHAIN_MAX = 8;
export const BrowserDownloadResumeSchema = Type.Object({
  urlChain: Type.Array(Type.String({ maxLength: BROWSER_RECORD_URL_MAX }), { minItems: 1, maxItems: BROWSER_DOWNLOAD_URL_CHAIN_MAX }),
  mimeType: Type.Optional(Type.String({ maxLength: 256 })), eTag: Type.Optional(Type.String({ maxLength: 1_024 })),
  lastModified: Type.Optional(Type.String({ maxLength: 256 })),
});
export const BrowserDownloadRecordSchema = Type.Object({ ...BrowserDownloadEntrySchema.properties, resume: Type.Optional(BrowserDownloadResumeSchema) });
export type BrowserDownloadResume = Static<typeof BrowserDownloadResumeSchema>;
export type BrowserDownloadRecord = Static<typeof BrowserDownloadRecordSchema>;

const HistoryInput = Type.Object({ ...BrowserHistoryEntrySchema.properties, favicon: Type.Optional(Type.Unknown()) });

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

export function persistableBrowserFavicon(value: unknown): string | undefined {
  if (typeof value === 'string' && value.startsWith('data:image/') && value.length <= 16 * 1024) return value;
  const favicon = boundedString(value, BROWSER_RECORD_FAVICON_MAX);
  if (favicon === null) return undefined;
  try {
    const protocol = new URL(favicon).protocol;
    return protocol === 'http:' || protocol === 'https:' ? favicon : undefined;
  } catch {
    return undefined;
  }
}

export function asBrowserHistoryEntry(value: unknown): BrowserHistoryEntry | null {
  const history = browserValidators.HistoryInput.Parse(value);
  if (history === null) return null;
  const { favicon: rawFavicon, ...record } = history;
  const favicon = persistableBrowserFavicon(rawFavicon);
  return { ...record, ...(favicon === undefined ? {} : { favicon }) };
}

export function asBrowserDownloadEntry(value: unknown): BrowserDownloadRecord | null {
  const entry = browserValidators.BrowserDownloadRecordSchema.Parse(value);
  if (entry === null) return null;
  const { savePath, urlTruncated, pathTruncated, resume, ...record } = entry;
  const urlAtCap = record.url.length >= BROWSER_RECORD_URL_MAX;
  const pathAtCap = savePath !== undefined && savePath.length >= BROWSER_RECORD_PATH_MAX;
  const urlCut = urlTruncated ?? urlAtCap;
  const pathCut = savePath !== undefined && (pathTruncated ?? pathAtCap);
  return {
    ...record,
    ...(urlCut || urlAtCap ? { urlTruncated: urlCut } : {}),
    ...(savePath === undefined ? {} : { savePath }),
    ...(pathCut || pathAtCap ? { pathTruncated: pathCut } : {}),
    ...(resume === undefined ? {} : {
      resume: {
        urlChain: resume.urlChain,
        ...(resume.mimeType === undefined ? {} : { mimeType: resume.mimeType }),
        ...(resume.eTag === undefined ? {} : { eTag: resume.eTag }),
        ...(resume.lastModified === undefined ? {} : { lastModified: resume.lastModified }),
      },
    }),
  };
}

export const browserValidators = {
  HistoryInput: defineBrowserValidator(HistoryInput),
  BrowserDownloadRecordSchema: defineBrowserValidator(BrowserDownloadRecordSchema),
};
