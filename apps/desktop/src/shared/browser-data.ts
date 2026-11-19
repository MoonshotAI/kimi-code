import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserSearchEngineSchema } from './browser-search';
import { BrowserZoomFactorSchema } from './browser-zoom';
import { BrowserCustomUserAgentSchema, BrowserUserAgentSavedPresetsSchema, isBrowserUserAgentSavedPresets } from './browser-user-agent';
import { BrowserAutoplaySchema, isBrowserAutoplay } from './browser-autoplay';
import { BrowserSoundSchema } from './browser-sound';

export const BROWSER_RECORD_URL_MAX = 4_096;
export const BROWSER_RECORD_TITLE_MAX = 512;
export const BROWSER_RECORD_FAVICON_MAX = 2_048;
export const BROWSER_RECORD_FILENAME_MAX = 512;
export const BROWSER_RECORD_PATH_MAX = 4_096;

export const BrowserHistoryEntrySchema = Type.Object({
  id: Type.String({ maxLength: 128 }), url: Type.String({ maxLength: BROWSER_RECORD_URL_MAX }),
  title: Type.String({ maxLength: BROWSER_RECORD_TITLE_MAX }), favicon: Type.Optional(Type.String()), visitedAt: Type.Number(),
});
export const BrowserDownloadEntrySchema = Type.Object({
  id: Type.String({ maxLength: 128 }), url: Type.String({ maxLength: BROWSER_RECORD_URL_MAX }), urlTruncated: Type.Optional(Type.Boolean()),
  filename: Type.String({ maxLength: BROWSER_RECORD_FILENAME_MAX }), savePath: Type.Optional(Type.String({ maxLength: BROWSER_RECORD_PATH_MAX })), pathTruncated: Type.Optional(Type.Boolean()),
  state: Type.Enum(['progressing', 'completed', 'cancelled', 'interrupted']),
  startedAt: Type.Number(), endedAt: Type.Optional(Type.Number()), receivedBytes: Type.Number(), totalBytes: Type.Number(),
});
export const BrowserDownloadItemSchema = Type.Object({
  ...BrowserDownloadEntrySchema.properties, fileMissing: Type.Optional(Type.Boolean()), active: Type.Optional(Type.Boolean()),
  resumable: Type.Optional(Type.Boolean()), speed: Type.Optional(Type.Number()),
});
export const BrowserDownloadItemsSchema = Type.Array(BrowserDownloadItemSchema, { maxItems: 100 });
export const BrowserDownloadIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export const BrowserDownloadsWatchSchema = Type.Boolean();
export const BrowserDownloadActionSchema = Type.Object({
  id: BrowserDownloadIdSchema, action: Type.Enum(['open', 'show', 'pause', 'resume', 'cancel', 'retry']),
}, { additionalProperties: false });
export const BROWSER_AGENT_DOWNLOAD_LIMIT_DEFAULT = 1_024 ** 3;
export const BROWSER_AGENT_DOWNLOAD_LIMITS = [100 * 1_024 ** 2, 500 * 1_024 ** 2, 1_024 ** 3, 5 * 1_024 ** 3] as const;
const AgentDownloadLimitSchema = Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]);
export const BrowserPreferencesSchema = Type.Object({
  agentControl: Type.Boolean(), subagentControl: Type.Boolean(), agentLocalFiles: Type.Boolean(), searchEngine: BrowserSearchEngineSchema, autoplay: BrowserAutoplaySchema, sound: BrowserSoundSchema, askWhereToSave: Type.Boolean(), defaultZoomFactor: BrowserZoomFactorSchema,
  customUserAgent: Type.Union([BrowserCustomUserAgentSchema, Type.Null()]),
  userAgentPresets: BrowserUserAgentSavedPresetsSchema,
  agentDownloadDirectory: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  agentDownloadLimitBytes: Type.Optional(AgentDownloadLimitSchema),
});
export const BrowserDownloadsAccessSchema = Type.Enum(['unknown', 'granted', 'denied']);
export const BrowserAgentDownloadLocationSchema = Type.Object({
  path: Type.String({ maxLength: 4096 }), custom: Type.Boolean(), fallback: Type.Boolean(), access: BrowserDownloadsAccessSchema,
});
export const BrowserDataSnapshotSchema = Type.Object({
  history: Type.Array(BrowserHistoryEntrySchema, { maxItems: 200 }), preferences: BrowserPreferencesSchema,
  defaultUserAgent: Type.String({ maxLength: 2_048 }),
  agentDownloads: Type.Optional(BrowserAgentDownloadLocationSchema),
});
export type BrowserHistoryEntry = Static<typeof BrowserHistoryEntrySchema>;
export type BrowserDownloadEntry = Static<typeof BrowserDownloadEntrySchema>;
export type BrowserDownloadItem = Static<typeof BrowserDownloadItemSchema>;
export type BrowserDownloadAction = Static<typeof BrowserDownloadActionSchema>;
export type BrowserDownloadControl = BrowserDownloadAction & { action: 'pause' | 'resume' | 'cancel' };
export type BrowserPreferences = Static<typeof BrowserPreferencesSchema>;
export type BrowserDownloadsAccess = Static<typeof BrowserDownloadsAccessSchema>;
export type BrowserAgentDownloadLocation = Static<typeof BrowserAgentDownloadLocationSchema>;
export type BrowserDataSnapshot = Static<typeof BrowserDataSnapshotSchema>;
export const BrowserPreferencesPatchSchema = Type.Object({
  agentControl: Type.Optional(Type.Boolean()), subagentControl: Type.Optional(Type.Boolean()), agentLocalFiles: Type.Optional(Type.Boolean()), searchEngine: Type.Optional(BrowserSearchEngineSchema), autoplay: Type.Optional(BrowserAutoplaySchema), sound: Type.Optional(BrowserSoundSchema), askWhereToSave: Type.Optional(Type.Boolean()),
  defaultZoomFactor: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2 })),
  customUserAgent: Type.Optional(Type.Union([BrowserCustomUserAgentSchema, Type.Null()])),
  userAgentPresets: Type.Optional(BrowserUserAgentSavedPresetsSchema),
  agentDownloadDirectory: Type.Optional(Type.Null()),
  agentDownloadLimitBytes: Type.Optional(AgentDownloadLimitSchema),
}, { additionalProperties: false });
export type BrowserPreferencesPatch = Static<typeof BrowserPreferencesPatchSchema>;

export function isBrowserPreferencesPatch(value: unknown): value is BrowserPreferencesPatch {
  if (!browserValidators.BrowserPreferencesPatchSchema.Check(value)) return false;
  return value.userAgentPresets === undefined || isBrowserUserAgentSavedPresets(value.userAgentPresets);
}

export function isBrowserDataSnapshot(value: unknown): value is BrowserDataSnapshot {
  return browserValidators.BrowserDataSnapshotSchema.Check(value);
}
export function isBrowserDownloadItems(value: unknown): value is BrowserDownloadItem[] {
  return browserValidators.BrowserDownloadItemsSchema.Check(value);
}

export function isBrowserDownloadsWatch(value: unknown): value is boolean {
  return browserValidators.BrowserDownloadsWatchSchema.Check(value);
}

export function isBrowserDownloadId(value: unknown): value is string {
  return browserValidators.BrowserDownloadIdSchema.Check(value);
}

export function asBrowserDownloadAction(value: unknown): BrowserDownloadAction | null {
  return browserValidators.BrowserDownloadActionSchema.Parse(value);
}
export type BrowserSettingsSection = 'settings' | 'downloads' | 'history' | 'sites';

export const browserValidators = {
  BrowserPreferencesPatchSchema: defineBrowserValidator(BrowserPreferencesPatchSchema),
  BrowserDataSnapshotSchema: defineBrowserValidator(BrowserDataSnapshotSchema),
  BrowserDownloadItemsSchema: defineBrowserValidator(BrowserDownloadItemsSchema),
  BrowserDownloadActionSchema: defineBrowserValidator(BrowserDownloadActionSchema),
  BrowserDownloadIdSchema: defineBrowserValidator(BrowserDownloadIdSchema),
  BrowserDownloadsWatchSchema: defineBrowserValidator(BrowserDownloadsWatchSchema),
};
