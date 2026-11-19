import { expect, it } from 'vitest';
import { browserDeviceMenuItems } from '../../src/renderer/lib/browserDeviceMenu';
import { BROWSER_DEVICE_PROFILES, asBrowserDeviceModeRequest } from '../../src/shared/browser-device';

it('groups every preset and selects the combined row for saved aliases', () => {
  const items = browserDeviceMenuItems('iphone-14-pro', key => key);
  expect(items.flatMap(item => item.kind === 'section' ? [item.id] : [])).toEqual(['phones', 'foldables', 'tablets', 'desktops']);
  const choices = items.filter(item => item.kind === 'item');
  expect(choices.filter(item => item.selected).map(item => item.id)).toEqual(['iphone-16']);
  expect(choices.filter(item => item.id !== 'responsive').every(item => item.metrics?.length === 2 && !item.description)).toBe(true);
  expect(choices.map(item => item.id).sort()).toEqual(BROWSER_DEVICE_PROFILES.filter(profile => profile.id !== 'iphone-14-pro').map(profile => profile.id).sort());
  expect(choices.find(item => item.id === 'desktop-1280')?.metrics).toEqual([{ label: 'browser.device.size', value: '1280 × 800' }, { label: 'DPR', value: '1' }]);
  expect(choices.find(item => item.id === 'iphone-duo-outer')?.metrics?.[0]?.value).toBe('466 × 678');
  expect(choices.find(item => item.id === 'iphone-duo-inner')?.metrics?.[0]?.value).toBe('669 × 951');
});

it.each(['iphone-duo-inner', 'iphone-duo-outer'] as const)('exposes %s as a selectable preset in both orientations', id => {
  const items = browserDeviceMenuItems(id, key => key);
  expect(items.filter(item => item.kind === 'item' && item.selected)).toHaveLength(1);
  for (const orientation of ['portrait', 'landscape']) {
    const request = { enabled: true, profileId: id, orientation, scaleMode: 'fit' };
    expect(asBrowserDeviceModeRequest(request)).toEqual(request);
  }
});
