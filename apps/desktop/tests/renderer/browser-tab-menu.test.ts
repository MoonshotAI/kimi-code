import { expect, it } from 'vitest';
import { browserTabMenuItems } from '../../src/renderer/lib/browserTabMenu';
import zh from '../../../../packages/app-i18n/src/locales/zh/browser';
import en from '../../../../packages/app-i18n/src/locales/en/browser';

it.each([zh, en])('provides the requested actions in order with icons and localized labels', locale => {
  const t = (key: string) => key.split('.').slice(1).reduce((value: any, part) => value[part], locale) as string;
  const items = browserTabMenuItems(t, { canOpen: true, canFork: true, hasUrl: true, hasWebUrl: true, canCopyUrl: true, muted: false, index: 0, count: 2 });
  const actions = items.filter(item => item.kind === 'item');
  expect(actions.map(item => item.id)).toEqual(['new-right', 'reload', 'duplicate', 'rename', 'copy-url', 'open-external', 'mute', 'fork', 'close', 'close-others', 'close-to-right']);
  expect(actions.every(item => item.label && !item.label.startsWith('browser.'))).toBe(true);
  expect(actions.every(item => item.icon)).toBe(true);
});

it('offers unmute and disables URL or fork actions where unavailable', () => {
  const items = browserTabMenuItems(key => key, { canOpen: true, canFork: false, hasUrl: false, hasWebUrl: false, canCopyUrl: false, muted: true, index: 0, count: 1 });
  expect(items).toContainEqual(expect.objectContaining({ id: 'unmute', icon: 'volume' }));
  for (const id of ['reload', 'copy-url', 'open-external', 'fork', 'close-others', 'close-to-right']) expect(items).toContainEqual(expect.objectContaining({ id, disabled: true }));
});

it('keeps reload and copy URL but disables opening a local file tab in the default browser', () => {
  const items = browserTabMenuItems(key => key, { canOpen: true, canFork: true, hasUrl: true, hasWebUrl: false, canCopyUrl: true, muted: false, index: 0, count: 1 });
  expect(items).toContainEqual(expect.objectContaining({ id: 'reload', disabled: false }));
  expect(items).toContainEqual(expect.objectContaining({ id: 'copy-url', disabled: false }));
  expect(items).toContainEqual(expect.objectContaining({ id: 'open-external', disabled: true }));
});
