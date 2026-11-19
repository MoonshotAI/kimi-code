import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserIdSchema } from './browser-schema';
import { BrowserSiteAutoplaySchema } from './browser-autoplay';
import { BrowserSiteSoundSchema } from './browser-sound';

export const BROWSER_SITE_PERMISSIONS = ['location', 'camera', 'microphone', 'notifications', 'clipboard', 'clipboardWrite', 'fullscreen', 'midi', 'midiSysex'] as const;
export const BrowserSitePermissionSchema = Type.Enum(BROWSER_SITE_PERMISSIONS);
export const BrowserSiteSettingSchema = Type.Enum(['ask', 'allow', 'block']);
const Permissions = Type.Partial(Type.Record(BrowserSitePermissionSchema, BrowserSiteSettingSchema), { additionalProperties: false, propertyNames: BrowserSitePermissionSchema, patternProperties: { '.*': BrowserSiteSettingSchema } });
export const BrowserSiteRecordSchema = Type.Object({ origin: Type.String({ maxLength: 32768 }), lastVisitedAt: Type.Number(), permissions: Permissions, autoplay: Type.Optional(BrowserSiteAutoplaySchema), sound: Type.Optional(BrowserSiteSoundSchema) });
export const BrowserSiteInfoSchema = Type.Object({ ...BrowserSiteRecordSchema.properties, cookieCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) });
export type BrowserSitePermission = Static<typeof BrowserSitePermissionSchema>;
export type BrowserSitePermissionSetting = Static<typeof BrowserSiteSettingSchema>;
export type BrowserSiteRecord = Static<typeof BrowserSiteRecordSchema>;
export type BrowserSiteInfo = Static<typeof BrowserSiteInfoSchema>;

export function browserSiteOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32768) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

export function isBrowserSitePermission(value: unknown): value is BrowserSitePermission {
  return browserValidators.BrowserSitePermissionSchema.Check(value);
}

export function isBrowserSiteSetting(value: unknown): value is BrowserSitePermissionSetting {
  return browserValidators.BrowserSiteSettingSchema.Check(value);
}

export function asBrowserSiteRecord(value: unknown): BrowserSiteRecord | null {
  const record = browserValidators.BrowserSiteRecordSchema.Parse(value);
  if (record === null) return null;
  const origin = browserSiteOrigin(record.origin);
  return origin === null ? null : { ...record, origin, permissions: { ...record.permissions } };
}

export function asBrowserSiteInfo(value: unknown): BrowserSiteInfo | null {
  if (!browserValidators.BrowserSiteInfoSchema.Check(value)) return null;
  const site = asBrowserSiteRecord(value);
  return site === null ? null : { ...site, cookieCount: value.cookieCount };
}

export const BrowserSitePermissionUpdateSchema = Type.Object({ origin: Type.String({ maxLength: 32768 }), permission: BrowserSitePermissionSchema, setting: BrowserSiteSettingSchema });
export function asBrowserSitePermissionUpdate(value: unknown): Static<typeof BrowserSitePermissionUpdateSchema> | null {
  const update = browserValidators.permissionUpdate.Parse(value);
  const origin = update === null ? null : browserSiteOrigin(update.origin);
  return update === null || origin === null ? null : { ...update, origin };
}

export const BrowserSiteAutoplayUpdateSchema = Type.Object({ origin: Type.String({ maxLength: 32768 }), setting: BrowserSiteAutoplaySchema }, { additionalProperties: false });
export function asBrowserSiteAutoplayUpdate(value: unknown): Static<typeof BrowserSiteAutoplayUpdateSchema> | null {
  const update = browserValidators.autoplayUpdate.Parse(value);
  const origin = update === null ? null : browserSiteOrigin(update.origin);
  return update === null || origin === null ? null : { ...update, origin };
}

export const BrowserSiteSoundUpdateSchema = Type.Object({ origin: Type.String({ maxLength: 32768 }), setting: BrowserSiteSoundSchema }, { additionalProperties: false });
export function asBrowserSiteSoundUpdate(value: unknown): Static<typeof BrowserSiteSoundUpdateSchema> | null {
  const update = browserValidators.soundUpdate.Parse(value);
  const origin = update === null ? null : browserSiteOrigin(update.origin);
  return update === null || origin === null ? null : { ...update, origin };
}

export const BrowserPermissionRequestSchema = Type.Object({ requestId: BrowserIdSchema, browserId: BrowserIdSchema, origin: Type.String({ maxLength: 32768 }), permissions: Type.Array(BrowserSitePermissionSchema, { minItems: 1, maxItems: BROWSER_SITE_PERMISSIONS.length }) });
export const BrowserPermissionRequestsSchema = Type.Array(BrowserPermissionRequestSchema, { maxItems: 64 });
export const BrowserPermissionDecisionSchema = Type.Object({ requestId: BrowserIdSchema, decision: Type.Enum(['allow-once', 'allow-always', 'block']) }, { additionalProperties: false });
export const BrowserSystemPermissionStatesSchema = Type.Array(BrowserSitePermissionSchema, { maxItems: BROWSER_SITE_PERMISSIONS.length });
export type BrowserPermissionRequest = Static<typeof BrowserPermissionRequestSchema>;
export type BrowserPermissionDecision = Static<typeof BrowserPermissionDecisionSchema>;
export type BrowserSystemPermissionStates = Static<typeof BrowserSystemPermissionStatesSchema>;

export function asBrowserSystemPermissionStates(value: unknown): BrowserSystemPermissionStates | null {
  const states = browserValidators.BrowserSystemPermissionStatesSchema.Parse(value);
  return states === null ? null : [...new Set(states)];
}

export const browserValidators = {
  permissionUpdate: defineBrowserValidator(BrowserSitePermissionUpdateSchema),
  autoplayUpdate: defineBrowserValidator(BrowserSiteAutoplayUpdateSchema),
  soundUpdate: defineBrowserValidator(BrowserSiteSoundUpdateSchema),
  BrowserPermissionRequestsSchema: defineBrowserValidator(BrowserPermissionRequestsSchema),
  BrowserPermissionDecisionSchema: defineBrowserValidator(BrowserPermissionDecisionSchema),
  BrowserSystemPermissionStatesSchema: defineBrowserValidator(BrowserSystemPermissionStatesSchema),
  BrowserSitePermissionSchema: defineBrowserValidator(BrowserSitePermissionSchema),
  BrowserSiteSettingSchema: defineBrowserValidator(BrowserSiteSettingSchema),
  BrowserSiteRecordSchema: defineBrowserValidator(BrowserSiteRecordSchema),
  BrowserSiteInfoSchema: defineBrowserValidator(BrowserSiteInfoSchema),
};
