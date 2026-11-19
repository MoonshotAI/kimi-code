import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserIdSchema } from './browser-schema';

export const BROWSER_DEVICE_DIMENSION_MIN = 50;
export const BROWSER_DEVICE_DIMENSION_MAX = 9_999;
export const BROWSER_DEVICE_SCALE_OPTIONS = [0.25, 0.5, 0.75, 1] as const;

export type BrowserDeviceProfileId = Static<typeof BrowserDeviceProfileIdSchema>;

export type BrowserDeviceOrientation = Static<typeof BrowserDeviceOrientationSchema>;
export type BrowserDeviceScaleMode = Static<typeof BrowserDeviceScaleModeSchema>;

export interface BrowserDeviceUserAgentMetadata {
  platform: 'Android' | 'iOS' | 'Windows';
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
}

export interface BrowserDeviceProfile {
  id: BrowserDeviceProfileId;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgentTemplate: string;
  userAgentMetadata: BrowserDeviceUserAgentMetadata;
}

const IOS_USER_AGENT =
  'Mozilla/5.0 (%s) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; %s) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%c Mobile Safari/537.36';

export const BROWSER_DEVICE_PROFILES = [
  {
    id: 'responsive',
    width: 393,
    height: 852,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgentTemplate: ANDROID_USER_AGENT.replace('%s', 'Pixel 7'),
    userAgentMetadata: {
      platform: 'Android',
      platformVersion: '13',
      architecture: '',
      model: 'Pixel 7',
      mobile: true,
    },
  },
  {
    id: 'iphone-se',
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPhone; CPU iPhone OS 18_5 like Mac OS X'),
    userAgentMetadata: {
      platform: 'iOS',
      platformVersion: '18.5',
      architecture: '',
      model: 'iPhone',
      mobile: true,
    },
  },
  {
    id: 'iphone-12-pro',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPhone; CPU iPhone OS 18_5 like Mac OS X'),
    userAgentMetadata: {
      platform: 'iOS',
      platformVersion: '18.5',
      architecture: '',
      model: 'iPhone',
      mobile: true,
    },
  },
  {
    id: 'iphone-14-pro',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPhone; CPU iPhone OS 18_5 like Mac OS X'),
    userAgentMetadata: {
      platform: 'iOS',
      platformVersion: '18.5',
      architecture: '',
      model: 'iPhone',
      mobile: true,
    },
  },
  {
    id: 'iphone-14-pro-max',
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPhone; CPU iPhone OS 18_5 like Mac OS X'),
    userAgentMetadata: {
      platform: 'iOS',
      platformVersion: '18.5',
      architecture: '',
      model: 'iPhone',
      mobile: true,
    },
  },
  {
    id: 'pixel-7',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgentTemplate: ANDROID_USER_AGENT.replace('%s', 'Pixel 7'),
    userAgentMetadata: {
      platform: 'Android',
      platformVersion: '13',
      architecture: '',
      model: 'Pixel 7',
      mobile: true,
    },
  },
  {
    id: 'galaxy-s20-ultra',
    width: 412,
    height: 915,
    deviceScaleFactor: 3.5,
    mobile: true,
    touch: true,
    userAgentTemplate: ANDROID_USER_AGENT.replace('%s', 'SM-G981B'),
    userAgentMetadata: {
      platform: 'Android',
      platformVersion: '13',
      architecture: '',
      model: 'SM-G981B',
      mobile: true,
    },
  },
  {
    id: 'ipad-mini',
    width: 768,
    height: 1_024,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPad; CPU OS 18_5 like Mac OS X'),
    userAgentMetadata: {
      platform: 'iOS',
      platformVersion: '18.5',
      architecture: '',
      model: 'iPad',
      mobile: true,
    },
  },
  {
    id: 'ipad-pro-13',
    width: 1_032,
    height: 1_376,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgentTemplate:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
    userAgentMetadata: {
      platform: 'iOS',
      platformVersion: '18.5',
      architecture: '',
      model: 'iPad',
      mobile: true,
    },
  },
  { id: 'iphone-duo-outer', width: 466, height: 678, deviceScaleFactor: 3, mobile: true, touch: true, userAgentTemplate: IOS_USER_AGENT.replace('18.5', '27.0').replace('%s', 'iPhone; CPU iPhone OS 27_0 like Mac OS X'), userAgentMetadata: { platform: 'iOS', platformVersion: '27.0', architecture: '', model: 'iPhone', mobile: true } },
  { id: 'iphone-duo-inner', width: 669, height: 951, deviceScaleFactor: 3, mobile: true, touch: true, userAgentTemplate: IOS_USER_AGENT.replace('18.5', '27.0').replace('%s', 'iPhone; CPU iPhone OS 27_0 like Mac OS X'), userAgentMetadata: { platform: 'iOS', platformVersion: '27.0', architecture: '', model: 'iPhone', mobile: true } },
  { id: 'iphone-16', width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPhone; CPU iPhone OS 18_5 like Mac OS X'), userAgentMetadata: { platform: 'iOS', platformVersion: '18.5', architecture: '', model: 'iPhone', mobile: true } },
  { id: 'iphone-16-pro', width: 402, height: 874, deviceScaleFactor: 3, mobile: true, touch: true, userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPhone; CPU iPhone OS 18_5 like Mac OS X'), userAgentMetadata: { platform: 'iOS', platformVersion: '18.5', architecture: '', model: 'iPhone', mobile: true } },
  { id: 'iphone-16-pro-max', width: 440, height: 956, deviceScaleFactor: 3, mobile: true, touch: true, userAgentTemplate: IOS_USER_AGENT.replace('%s', 'iPhone; CPU iPhone OS 18_5 like Mac OS X'), userAgentMetadata: { platform: 'iOS', platformVersion: '18.5', architecture: '', model: 'iPhone', mobile: true } },
  { id: 'pixel-8', width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgentTemplate: ANDROID_USER_AGENT.replace('Android 13', 'Android 14').replace('%s', 'Pixel 8'), userAgentMetadata: { platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 8', mobile: true } },
  { id: 'pixel-9', width: 412, height: 924, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgentTemplate: ANDROID_USER_AGENT.replace('Android 13', 'Android 14').replace('%s', 'Pixel 9'), userAgentMetadata: { platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 9', mobile: true } },
  { id: 'desktop-1280', width: 800, height: 1280, deviceScaleFactor: 1, mobile: false, touch: false, userAgentTemplate: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%c Safari/537.36', userAgentMetadata: { platform: 'Windows', platformVersion: '10', architecture: 'x86', model: '', mobile: false } },
  { id: 'desktop-1440', width: 900, height: 1440, deviceScaleFactor: 1, mobile: false, touch: false, userAgentTemplate: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%c Safari/537.36', userAgentMetadata: { platform: 'Windows', platformVersion: '10', architecture: 'x86', model: '', mobile: false } },
  { id: 'desktop-1920', width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false, touch: false, userAgentTemplate: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%c Safari/537.36', userAgentMetadata: { platform: 'Windows', platformVersion: '10', architecture: 'x86', model: '', mobile: false } },
] as const satisfies readonly (Omit<BrowserDeviceProfile, 'id'> & { id: string })[];

export const BrowserDeviceProfileIdSchema = Type.Enum(BROWSER_DEVICE_PROFILES.map(profile => profile.id));

export function getBrowserDeviceProfile(id: BrowserDeviceProfileId): BrowserDeviceProfile {
  return BROWSER_DEVICE_PROFILES.find((profile) => profile.id === id)!;
}

export const BrowserDeviceOrientationSchema = Type.Enum(['portrait', 'landscape']);
export const BrowserDeviceScaleModeSchema = Type.Enum(['fit', 'fixed']);
const Dimension = Type.Integer({ minimum: BROWSER_DEVICE_DIMENSION_MIN, maximum: BROWSER_DEVICE_DIMENSION_MAX });
const Scale = Type.Number({ minimum: 0.01, maximum: 1 });
export const BrowserDeviceStateSchema = Type.Object({
  profileId: BrowserDeviceProfileIdSchema, orientation: BrowserDeviceOrientationSchema,
  width: Dimension, height: Dimension, deviceScaleFactor: Type.Number({ exclusiveMinimum: 0, maximum: 10 }),
  mobile: Type.Boolean(), touch: Type.Boolean(), scaleMode: BrowserDeviceScaleModeSchema,
  requestedScale: Scale, displayScale: Scale, maxDisplayScale: Scale,
});
export type BrowserDeviceState = Static<typeof BrowserDeviceStateSchema>;

export interface BrowserDeviceViewRect { x: number; y: number; width: number; height: number }

export function browserDeviceViewBounds(bounds: BrowserDeviceViewRect, device: BrowserDeviceState | undefined): BrowserDeviceViewRect {
  if (device === undefined) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const width = Math.min(bounds.width, Math.round(device.width * device.displayScale));
  const height = Math.min(bounds.height, Math.round(device.height * device.displayScale));
  return {
    x: bounds.x + Math.max(0, Math.floor((bounds.width - width) / 2)),
    y: bounds.y + Math.max(0, Math.floor((bounds.height - height) / 2)),
    width,
    height,
  };
}

const Base = { enabled: Type.Literal(true), orientation: BrowserDeviceOrientationSchema };
const Preset = { profileId: Type.Enum(BROWSER_DEVICE_PROFILES.map(profile => profile.id).filter(id => id !== 'responsive')), width: Type.Optional(Type.Never()), height: Type.Optional(Type.Never()) };
const Responsive = { profileId: Type.Literal('responsive'), width: Dimension, height: Dimension };
const Fit = { scaleMode: Type.Literal('fit'), scale: Type.Optional(Type.Never()) };
const Fixed = { scaleMode: Type.Literal('fixed'), scale: Scale };
export const BrowserDeviceModeRequestSchema = Type.Union([
  Type.Object({ enabled: Type.Literal(false) }, { additionalProperties: false }),
  Type.Object({ ...Base, ...Preset, ...Fit }, { additionalProperties: false }),
  Type.Object({ ...Base, ...Preset, ...Fixed }, { additionalProperties: false }),
  Type.Object({ ...Base, ...Responsive, ...Fit }, { additionalProperties: false }),
  Type.Object({ ...Base, ...Responsive, ...Fixed }, { additionalProperties: false }),
], { description: 'Disable with {enabled:false}. Enabling requires profileId, orientation and scaleMode. Responsive requires width and height; presets forbid them. Fixed requires scale (0.01–1); fit forbids scale.' });
export type BrowserDeviceModeRequest = Static<typeof BrowserDeviceModeRequestSchema>;

const DeviceInput = Type.Object({
  enabled: Type.Boolean(), profileId: Type.Optional(Type.Unknown()), orientation: Type.Optional(Type.Unknown()),
  scaleMode: Type.Optional(Type.Unknown()), scale: Type.Optional(Type.Unknown()), width: Type.Optional(Type.Unknown()), height: Type.Optional(Type.Unknown()),
});

export function asBrowserDeviceModeRequest(value: unknown): BrowserDeviceModeRequest | null {
  const input = browserValidators.DeviceInput.Parse(value);
  if (input === null) return null;
  if (input.enabled === false) return { enabled: false };
  const candidate = Object.fromEntries(Object.entries(input).filter(([, field]) => field !== undefined));
  return browserValidators.BrowserDeviceModeRequestSchema.Check(candidate) ? candidate : null;
}

export const BrowserDeviceModeUpdateSchema = Type.Object({ browserId: BrowserIdSchema, request: BrowserDeviceModeRequestSchema });
export function asBrowserDeviceModeUpdate(value: unknown): { browserId: Static<typeof BrowserIdSchema>; request: BrowserDeviceModeRequest } | null {
  const update = browserValidators.update.Parse(value);
  const request = update === null ? null : asBrowserDeviceModeRequest(update.request);
  return update === null || request === null ? null : { browserId: update.browserId, request };
}

export function isBrowserDeviceState(value: unknown): value is BrowserDeviceState {
  return browserValidators.BrowserDeviceStateSchema.Check(value);
}

export const browserValidators = {
  DeviceInput: defineBrowserValidator(DeviceInput),
  update: defineBrowserValidator(BrowserDeviceModeUpdateSchema),
  BrowserDeviceModeRequestSchema: defineBrowserValidator(BrowserDeviceModeRequestSchema),
  BrowserDeviceStateSchema: defineBrowserValidator(BrowserDeviceStateSchema),
};
