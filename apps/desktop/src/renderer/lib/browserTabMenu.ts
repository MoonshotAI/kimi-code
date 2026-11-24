import type { NativeMenuItem } from '@moonshot-ai/app-core/native-menu';

const actions = ['new-right', 'reload', 'duplicate', 'rename', 'copy-url', 'open-external', 'mute', 'unmute', 'fork', 'close', 'close-others', 'close-to-right'] as const;
export type BrowserTabAction = typeof actions[number];
export function isBrowserTabAction(value: string): value is BrowserTabAction {
  return (actions as readonly string[]).includes(value);
}

export function browserTabMenuItems(t: (key: string) => string, options: { canOpen: boolean; canFork: boolean; hasUrl: boolean; hasWebUrl: boolean; canCopyUrl: boolean; muted: boolean; index: number; count: number }): NativeMenuItem[] {
  return [
    { kind: 'item', id: 'new-right', label: t('browser.tabMenu.newToRight'), icon: 'tab-new-right', disabled: !options.canOpen },
    { kind: 'separator' },
    { kind: 'item', id: 'reload', label: t('browser.reload'), icon: 'refresh', disabled: !options.hasUrl },
    { kind: 'item', id: 'duplicate', label: t('browser.tabMenu.duplicate'), icon: 'copy', disabled: !options.canOpen },
    { kind: 'item', id: 'rename', label: t('browser.tabMenu.rename'), icon: 'file-edit' },
    { kind: 'item', id: 'copy-url', label: t('browser.tabMenu.copyUrl'), icon: 'link', disabled: !options.canCopyUrl },
    { kind: 'item', id: 'open-external', label: t('browser.tabMenu.openExternal'), icon: 'external-link', disabled: !options.hasWebUrl },
    { kind: 'item', id: options.muted ? 'unmute' : 'mute', label: t(options.muted ? 'browser.tabMenu.unmute' : 'browser.tabMenu.mute'), icon: options.muted ? 'volume' : 'volume-off' },
    { kind: 'separator' },
    { kind: 'item', id: 'fork', label: t('browser.tabMenu.fork'), icon: 'git-fork', disabled: !options.canFork },
    { kind: 'separator' },
    { kind: 'item', id: 'close', label: t('browser.tabMenu.close'), icon: 'close' },
    { kind: 'item', id: 'close-others', label: t('browser.tabMenu.closeOthers'), icon: 'tab-close-others', disabled: options.count <= 1 },
    { kind: 'item', id: 'close-to-right', label: t('browser.tabMenu.closeToRight'), icon: 'tab-close-right', disabled: options.index < 0 || options.index === options.count - 1 },
  ];
}
