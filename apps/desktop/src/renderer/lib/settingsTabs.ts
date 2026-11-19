import type { IconName } from '@moonshot-ai/app-client/icons';

export type SettingsTab =
  | 'general'
  | 'browser'
  | 'agent'
  | 'account'
  | 'providers'
  | 'hosts'
  | 'remoteControl'
  | 'worktrees'
  | 'plugins'
  | 'advanced'
  | 'lab'
  | 'archived'
  | 'shortcuts';

export interface SettingsTabDef {
  id: SettingsTab;
  labelKey: string;
  icon: IconName;
}

export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { id: 'general', labelKey: 'settings.tabs.general', icon: 'sliders' },
  { id: 'account', labelKey: 'settings.tabs.account', icon: 'user' },
  { id: 'agent', labelKey: 'settings.tabs.agent', icon: 'robot' },
  { id: 'providers', labelKey: 'settings.tabs.providers', icon: 'bolt' },
  { id: 'hosts', labelKey: 'settings.tabs.hosts', icon: 'server' },
  { id: 'remoteControl', labelKey: 'settings.tabs.remoteControl', icon: 'device-mobile' },
  { id: 'browser', labelKey: 'settings.tabs.browser', icon: 'browser' },
  { id: 'worktrees', labelKey: 'worktreeManage.tabLabel', icon: 'git-fork' },
  { id: 'plugins', labelKey: 'settings.tabs.plugins', icon: 'plugin' },
  { id: 'shortcuts', labelKey: 'settings.tabs.shortcuts', icon: 'keyboard' },
  { id: 'advanced', labelKey: 'settings.tabs.advanced', icon: 'info' },
  { id: 'lab', labelKey: 'settings.tabs.lab', icon: 'flask' },
  { id: 'archived', labelKey: 'settings.tabs.archived', icon: 'archive' },
];

export function visibleSettingsTabs(
  desktopBridge: boolean,
  pluginsUnsupported: boolean,
): SettingsTabDef[] {
  return SETTINGS_TABS.filter(
    (tab) =>
      (tab.id !== 'plugins' || !pluginsUnsupported) &&
      (desktopBridge ||
        (tab.id !== 'browser' && tab.id !== 'shortcuts' && tab.id !== 'remoteControl')),
  );
}
