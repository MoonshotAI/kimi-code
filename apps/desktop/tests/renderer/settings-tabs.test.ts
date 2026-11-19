import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS, visibleSettingsTabs } from '../../src/renderer/lib/settingsTabs';

describe('visibleSettingsTabs', () => {
  it('lists every tab in the desktop shell', () => {
    expect(visibleSettingsTabs(true, false).map((tab) => tab.id)).toEqual(
      SETTINGS_TABS.map((tab) => tab.id),
    );
    expect(SETTINGS_TABS.find((tab) => tab.id === 'plugins')?.icon).toBe('plugin');
  });

  it('keeps Remote Control inside the devices tab', () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).not.toContain('remoteControl');
    expect(SETTINGS_TABS.find((tab) => tab.id === 'devices')?.icon).toBe('device-desktop');
  });

  it('hides the browser and shortcuts tabs without the desktop bridge', () => {
    expect(visibleSettingsTabs(false, false).map((tab) => tab.id)).toEqual([
      'general',
      'account',
      'agent',
      'providers',
      'devices',
      'plugins',
      'advanced',
      'lab',
      'archived',
    ]);
  });

  it('also hides the plugins tab when unsupported without the desktop bridge', () => {
    expect(visibleSettingsTabs(false, true).map((tab) => tab.id)).toEqual([
      'general',
      'account',
      'agent',
      'providers',
      'devices',
      'advanced',
      'lab',
      'archived',
    ]);
  });

  it('hides only the plugins tab in the desktop shell when unsupported', () => {
    const ids = visibleSettingsTabs(true, true).map((tab) => tab.id);
    expect(ids).toContain('browser');
    expect(ids).toContain('shortcuts');
    expect(ids).toContain('devices');
    expect(ids).not.toContain('plugins');
  });
});
