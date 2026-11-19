import { BROWSER_DEVICE_PROFILES, type BrowserDeviceProfileId } from '../../shared/browser-device';
import type { BrowserOverlayMenuRequest } from '../../shared/browser-overlay';

export const profileLabelKeys: Record<BrowserDeviceProfileId, string> = {
  'iphone-duo-inner': 'browser.device.iphoneDuoInner',
  'iphone-duo-outer': 'browser.device.iphoneDuoOuter',
  responsive: 'browser.device.responsive',
  'iphone-16': 'browser.device.iphone-16',
  'iphone-16-pro': 'browser.device.iphone-16-pro',
  'iphone-16-pro-max': 'browser.device.iphone-16-pro-max',
  'pixel-8': 'browser.device.pixel-8',
  'pixel-9': 'browser.device.pixel-9',
  'desktop-1280': 'browser.device.desktop-1280',
  'desktop-1440': 'browser.device.desktop-1440',
  'desktop-1920': 'browser.device.desktop-1920',
  'iphone-se': 'browser.device.iphoneSe',
  'iphone-12-pro': 'browser.device.iphone12Pro',
  'iphone-14-pro': 'browser.device.iphone14Pro',
  'iphone-14-pro-max': 'browser.device.iphone14ProMax',
  'pixel-7': 'browser.device.pixel7',
  'galaxy-s20-ultra': 'browser.device.galaxyS20Ultra',
  'ipad-mini': 'browser.device.ipadMini',
  'ipad-pro-13': 'browser.device.ipadPro13',
};

const groups: { id: string; profiles: BrowserDeviceProfileId[] }[] = [
  { id: 'phones', profiles: ['iphone-se', 'iphone-12-pro', 'iphone-16', 'iphone-14-pro-max', 'iphone-16-pro', 'iphone-16-pro-max', 'pixel-7', 'pixel-8', 'pixel-9', 'galaxy-s20-ultra'] },
  { id: 'foldables', profiles: ['iphone-duo-outer', 'iphone-duo-inner'] },
  { id: 'tablets', profiles: ['ipad-mini', 'ipad-pro-13'] },
  { id: 'desktops', profiles: ['desktop-1280', 'desktop-1440', 'desktop-1920'] },
];

export function browserDeviceMenuItems(selected: BrowserDeviceProfileId, t: (key: string) => string): BrowserOverlayMenuRequest['items'] {
  const selectedId = selected === 'iphone-14-pro' ? 'iphone-16' : selected;
  return [
    { kind: 'item', id: 'responsive', label: t(profileLabelKeys.responsive), selected: selectedId === 'responsive' },
    ...groups.flatMap(group => [
      { kind: 'section' as const, id: group.id, label: t(`browser.device.${group.id}`) },
      ...group.profiles.map(id => {
        const profile = BROWSER_DEVICE_PROFILES.find(entry => entry.id === id)!;
        const width = profile.mobile ? profile.width : profile.height;
        const height = profile.mobile ? profile.height : profile.width;
        return { kind: 'item' as const, id, label: t(profileLabelKeys[id]), metrics: [{ label: t('browser.device.size'), value: `${width} × ${height}` }, { label: 'DPR', value: String(profile.deviceScaleFactor) }], selected: selectedId === id };
      }),
    ]),
  ];
}
