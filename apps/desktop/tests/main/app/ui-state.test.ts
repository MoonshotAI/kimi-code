import { getWindowsLidBackups, saveWindowsLidBackups, getWindowsLidActionDcOriginal, setWindowsLidActionDcOriginal, savePreventLidSleep, clampMainWindowZoomLevel, getMainWindowZoomLevel, setMainWindowZoomLevel } from '../../../src/main/app/ui-state';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getColorScheme, getRemoteControlRestoreState, savePendingSessionContinue, setColorScheme, setRemoteControlPreviousEnabled, setRemoteControlRestoreEnabled, takePendingSessionContinue } from '../../../src/main/app/ui-state';
import { getBrowserDownloadsAccess, getBrowserPreferences, getPreventLidSleep, getPreventSystemSleep, getWindowsLidActionAcOriginal, saveBrowserDownloadsAccess, getBrowserRecords, isOnboarded, isUpdateAutoDownloadEnabled, isVibrancyEnabled, getDockIconChoice, loadUiState, markFirstLaunchReported, markOnboarded, saveBrowserPreferences, saveBrowserRecords, saveDockIconChoice, setPreventLidSleep, setPreventSystemSleep, setUpdateAutoDownloadEnabled, setVibrancyEnabled, setWindowsLidActionAcOriginal, shouldReportFirstLaunch } from '../../../src/main/app/ui-state';

describe('ui-state persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-ui-state-'));
    file = join(dir, 'ui-state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves both lid actions together while preserving other state', () => {
    writeFileSync(file, JSON.stringify({ onboarded: true }));
    const backups = { '11111111-1111-1111-1111-111111111111': { ac: 2, dc: 3 } };
    saveWindowsLidBackups(backups, file);
    expect(getWindowsLidBackups(file)).toEqual(backups);
    expect(isOnboarded(file)).toBe(true);
  });

  it('throws on unreadable or unwritable backup storage', () => {
    writeFileSync(file, 'invalid json');
    expect(() => saveWindowsLidBackups({}, file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('invalid json');
    expect(() => saveWindowsLidBackups({}, join(file, 'state.json'))).toThrow();
  });

  it.each([true, false])('reports failed lid preference writes for enabled=%s', (enabled) => {
    savePreventLidSleep(!enabled, file);
    mkdirSync(`${file}.tmp`);
    expect(() => savePreventLidSleep(enabled, file)).toThrow();
    expect(getPreventLidSleep(file)).toBe(!enabled);
    rmSync(`${file}.tmp`, { recursive: true });
    savePreventLidSleep(enabled, file);
    expect(getPreventLidSleep(file)).toBe(enabled);
  });

  it('preserves existing backups when another preference write fails', () => {
    const backups = { '11111111-1111-1111-1111-111111111111': { ac: 2, dc: 3 } };
    saveWindowsLidBackups(backups, file);
    mkdirSync(`${file}.tmp`);
    setPreventLidSleep(true, file);
    expect(getWindowsLidBackups(file)).toEqual(backups);
    expect(() => saveWindowsLidBackups({}, file)).toThrow();
    expect(getWindowsLidBackups(file)).toEqual(backups);
  });

  it.each(['{"onboarded":', 'null', '[]'])('recovers ordinary preferences while preserving corrupt content: %s', (content) => {
    writeFileSync(file, content);
    markOnboarded(file);
    setVibrancyEnabled(false, file);
    setUpdateAutoDownloadEnabled(true, file);
    expect(isOnboarded(file)).toBe(true);
    expect(isVibrancyEnabled(file)).toBe(false);
    expect(isUpdateAutoDownloadEnabled(file)).toBe(true);
    const copies = readdirSync(dir).filter((name) => name.startsWith('ui-state.json.corrupt-'));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]!), 'utf8')).toBe(content);
    expect(() => getWindowsLidBackups(file)).toThrow('require recovery');
    expect(() => saveWindowsLidBackups({}, file)).toThrow('require recovery');
  });

  it('treats a missing or unreadable file as not onboarded', () => {
    expect(isOnboarded(file)).toBe(false);
    writeFileSync(file, 'not json', 'utf-8');
    expect(isOnboarded(file)).toBe(false);
    writeFileSync(file, '{"onboarded":"yes"}', 'utf-8');
    expect(isOnboarded(file)).toBe(false);
  });

  it('markOnboarded writes the flag and preserves other keys', () => {
    writeFileSync(file, '{"other":1}', 'utf-8');
    markOnboarded(file);
    expect(isOnboarded(file)).toBe(true);
    expect(loadUiState(file)).toEqual({ other: 1, onboarded: true });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ other: 1, onboarded: true });
  });

  it('creates the parent directory when missing', () => {
    const nested = join(dir, 'a', 'b', 'ui-state.json');
    markOnboarded(nested);
    expect(isOnboarded(nested)).toBe(true);
  });

  it('markOnboarded is idempotent', () => {
    markOnboarded(file);
    markOnboarded(file);
    expect(loadUiState(file)).toEqual({ onboarded: true });
  });

  it('treats a missing or unreadable vibrancy flag as enabled (default on)', () => {
    expect(isVibrancyEnabled(file)).toBe(true);
    writeFileSync(file, 'not json', 'utf-8');
    expect(isVibrancyEnabled(file)).toBe(true);
    writeFileSync(file, '{"vibrancy":"no"}', 'utf-8');
    expect(isVibrancyEnabled(file)).toBe(true);
  });

  it('setVibrancyEnabled round-trips and preserves other keys', () => {
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    setVibrancyEnabled(false, file);
    expect(isVibrancyEnabled(file)).toBe(false);
    expect(loadUiState(file)).toEqual({ onboarded: true, vibrancy: false });
    setVibrancyEnabled(true, file);
    expect(isVibrancyEnabled(file)).toBe(true);
  });

  it('remembers the color scheme, defaulting to the system theme and skipping no-op writes', () => {
    expect(getColorScheme(file)).toBe('system');
    writeFileSync(file, '{"onboarded":true,"colorScheme":"sepia"}', 'utf-8');
    expect(getColorScheme(file)).toBe('system');

    setColorScheme('dark', file);
    expect(loadUiState(file)).toEqual({ onboarded: true, colorScheme: 'dark' });
    const untouched = '{ "onboarded": true, "colorScheme": "dark" }';
    writeFileSync(file, untouched, 'utf-8');
    setColorScheme('dark', file);
    expect(readFileSync(file, 'utf-8')).toBe(untouched);

    setColorScheme('system', file);
    expect(getColorScheme(file)).toBe('system');
  });

  it('setPreventSystemSleep round-trips and preserves other keys', () => {
    expect(getPreventSystemSleep(file)).toBe('allow-sleep');
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    setPreventSystemSleep('prevent-app-suspension', file);
    expect(getPreventSystemSleep(file)).toBe('prevent-app-suspension');
    expect(loadUiState(file)).toEqual({ onboarded: true, preventSystemSleep: 'prevent-app-suspension' });
    setPreventSystemSleep('allow-sleep', file);
    expect(getPreventSystemSleep(file)).toBe('allow-sleep');
  });

  it('persists independent lid backups including zero and clears them after restoration', () => {
    setWindowsLidActionAcOriginal(2, file);
    setWindowsLidActionDcOriginal(0, file);
    expect(getWindowsLidActionAcOriginal(file)).toBe(2);
    expect(getWindowsLidActionDcOriginal(file)).toBe(0);
    setWindowsLidActionAcOriginal(undefined, file);
    setWindowsLidActionDcOriginal(undefined, file);
    expect(getWindowsLidActionAcOriginal(file)).toBeUndefined();
    expect(getWindowsLidActionDcOriginal(file)).toBeUndefined();
    writeFileSync(file, '{"windowsLidActionDcOriginal":7}', 'utf-8');
    expect(getWindowsLidActionDcOriginal(file)).toBeUndefined();
  });

  it('setPreventLidSleep round-trips and preserves other keys', () => {
    expect(getPreventLidSleep(file)).toBe(false);
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    setPreventLidSleep(true, file);
    expect(getPreventLidSleep(file)).toBe(true);
    expect(loadUiState(file)).toEqual({ onboarded: true, preventLidSleep: true });
    setPreventLidSleep(false, file);
    expect(getPreventLidSleep(file)).toBe(false);
  });

  it('migrates boolean sleep preferences and persists the display mode', () => {
    writeFileSync(file, '{"preventSystemSleep":true,"onboarded":true}', 'utf-8');
    expect(getPreventSystemSleep(file)).toBe('prevent-app-suspension');
    setPreventSystemSleep('prevent-display-sleep', file);
    expect(getPreventSystemSleep(file)).toBe('prevent-display-sleep');
    expect(loadUiState(file).onboarded).toBe(true);
    writeFileSync(file, '{"preventSystemSleep":false}', 'utf-8');
    expect(getPreventSystemSleep(file)).toBe('allow-sleep');
    writeFileSync(file, '{"preventSystemSleep":"invalid"}', 'utf-8');
    expect(getPreventSystemSleep(file)).toBe('allow-sleep');
  });

  it('windows lid action original validates and round-trips', () => {
    expect(getWindowsLidActionAcOriginal(file)).toBeUndefined();
    setWindowsLidActionAcOriginal(2, file);
    expect(getWindowsLidActionAcOriginal(file)).toBe(2);
    writeFileSync(file, '{"windowsLidActionAcOriginal":7}', 'utf-8');
    expect(getWindowsLidActionAcOriginal(file)).toBeUndefined();
    writeFileSync(file, '{"windowsLidActionAcOriginal":"yes"}', 'utf-8');
    expect(getWindowsLidActionAcOriginal(file)).toBeUndefined();
  });

  it('defaults updateAutoDownload to disabled unless explicitly enabled', () => {
    expect(isUpdateAutoDownloadEnabled(file)).toBe(false);
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    expect(isUpdateAutoDownloadEnabled(file)).toBe(false);
    writeFileSync(file, '{"updateAutoDownload":true}', 'utf-8');
    expect(isUpdateAutoDownloadEnabled(file)).toBe(true);
    writeFileSync(file, '{"updateAutoDownload":"yes"}', 'utf-8');
    expect(isUpdateAutoDownloadEnabled(file)).toBe(false);
  });

  it('setUpdateAutoDownloadEnabled writes the flag and preserves other keys', () => {
    markOnboarded(file);
    setUpdateAutoDownloadEnabled(false, file);
    expect(loadUiState(file)).toEqual({ onboarded: true, updateAutoDownload: false });
    setUpdateAutoDownloadEnabled(true, file);
    expect(loadUiState(file)).toEqual({ onboarded: true, updateAutoDownload: true });
  });

  it('persists independent Remote Control restore preferences', () => {
    expect(getRemoteControlRestoreState(file)).toEqual({
      restoreEnabled: false,
      previousEnabled: false,
    });

    setRemoteControlRestoreEnabled(true, file);
    expect(getRemoteControlRestoreState(file)).toEqual({
      restoreEnabled: true,
      previousEnabled: false,
    });

    setRemoteControlPreviousEnabled(true, file);
    expect(getRemoteControlRestoreState(file)).toEqual({
      restoreEnabled: true,
      previousEnabled: true,
    });

    setRemoteControlRestoreEnabled(false, file);
    expect(getRemoteControlRestoreState(file)).toEqual({
      restoreEnabled: false,
      previousEnabled: true,
    });
  });

  it('persists the agent download folder, size limit and Downloads access', () => {
    expect(getBrowserDownloadsAccess(file)).toBe('unknown');
    saveBrowserPreferences({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [], agentDownloadDirectory: '/Volumes/Work', agentDownloadLimitBytes: null }, file);
    expect(getBrowserPreferences(file)).toMatchObject({ agentDownloadDirectory: '/Volumes/Work', agentDownloadLimitBytes: null });
    saveBrowserPreferences({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [], agentDownloadLimitBytes: 1_024 }, file);
    expect(getBrowserPreferences(file)).toEqual({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [], agentDownloadLimitBytes: 1_024 });
    saveBrowserDownloadsAccess('denied', file);
    expect(getBrowserDownloadsAccess(file)).toBe('denied');
    writeFileSync(file, '{"browserAgentDownloadLimitBytes":-5,"browserAgentDownloadDirectory":"","browserDownloadsAccess":"maybe"}', 'utf-8');
    expect(getBrowserPreferences(file)).toEqual({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] });
    expect(getBrowserDownloadsAccess(file)).toBe('unknown');
  });

  it('persists bounded Browser download and zoom preferences', () => {
    expect(getBrowserPreferences(file)).toEqual({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] });
    saveBrowserPreferences({ agentControl: false, subagentControl: false, agentLocalFiles: false, askWhereToSave: false, autoplay: 'allow', sound: 'on', defaultZoomFactor: 1.25, searchEngine: 'bing', customUserAgent: null, userAgentPresets: [] }, file);
    expect(getBrowserPreferences(file)).toEqual({
      agentControl: false, subagentControl: false, agentLocalFiles: false,
      askWhereToSave: false,
      autoplay: 'allow',
      sound: 'on',
      defaultZoomFactor: 1.25,
      searchEngine: 'bing',
      customUserAgent: null,
      userAgentPresets: [],
    });
    writeFileSync(
      file,
      '{"browserAgentControl":"no","browserAskWhereToSave":"no","browserDefaultZoomFactor":99,"browserAutoplay":"https://example.test/media"}',
      'utf-8',
    );
    expect(getBrowserPreferences(file)).toEqual({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] });
  });

  it('defaults agent local files off and persists only explicit boolean values', () => {
    expect(getBrowserPreferences(file).agentLocalFiles).toBe(false);
    saveBrowserPreferences({ ...getBrowserPreferences(file), agentLocalFiles: true }, file);
    expect(getBrowserPreferences(file).agentLocalFiles).toBe(true);
    expect(loadUiState(file).browserAgentLocalFiles).toBe(true);
    for (const stored of ['"yes"', '1', 'null', '{}']) {
      writeFileSync(file, `{"browserAgentLocalFiles":${stored}}`, 'utf-8');
      expect(getBrowserPreferences(file).agentLocalFiles).toBe(false);
    }
  });

  it('defaults subagent browser control off and persists only explicit boolean values', () => {
    expect(getBrowserPreferences(file).subagentControl).toBe(false);
    saveBrowserPreferences({ agentControl: false, subagentControl: true, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] }, file);
    expect(getBrowserPreferences(file)).toMatchObject({ agentControl: false, subagentControl: true });
    expect(loadUiState(file).browserSubagentControl).toBe(true);
    for (const stored of ['"yes"', '1', 'null', '{}']) {
      writeFileSync(file, `{"browserSubagentControl":${stored}}`, 'utf-8');
      expect(getBrowserPreferences(file).subagentControl).toBe(false);
    }
  });

  it('persists a valid custom Browser user agent and drops invalid stored values', () => {
    saveBrowserPreferences({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: 'Custom/1.0', userAgentPresets: [] }, file);
    expect(getBrowserPreferences(file).customUserAgent).toBe('Custom/1.0');
    saveBrowserPreferences({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] }, file);
    expect(getBrowserPreferences(file).customUserAgent).toBeNull();
    for (const stored of ['"Bad\\nAgent"', '""', '"   "', `"${'a'.repeat(513)}"`, '42']) {
      writeFileSync(file, `{"browserCustomUserAgent":${stored}}`, 'utf-8');
      expect(getBrowserPreferences(file).customUserAgent).toBeNull();
    }
  });

  it('persists saved Browser user agent presets and drops invalid stored entries', () => {
    const presets = [{ name: 'Staging', value: 'Custom/1.0' }, { name: 'Mobile', value: 'Mobile/2.0' }];
    saveBrowserPreferences({ agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: presets }, file);
    expect(getBrowserPreferences(file).userAgentPresets).toEqual(presets);
    const stored = [
      { name: 'Keep', value: 'Keep/1.0' },
      { name: 'keep', value: 'Duplicate/1.0' },
      { name: '', value: 'Empty/1.0' },
      { name: 'Bad', value: 'Bad\nAgent' },
      { name: 'x'.repeat(61), value: 'Long/1.0' },
      'nope',
      ...Array.from({ length: 30 }, (_, index) => ({ name: `Preset ${index}`, value: `Agent/${index}` })),
    ];
    writeFileSync(file, JSON.stringify({ browserUserAgentPresets: stored }), 'utf-8');
    const loaded = getBrowserPreferences(file).userAgentPresets;
    expect(loaded).toHaveLength(20);
    expect(loaded[0]).toEqual({ name: 'Keep', value: 'Keep/1.0' });
    expect(loaded[1]).toEqual({ name: 'Preset 0', value: 'Agent/0' });
    writeFileSync(file, '{"browserUserAgentPresets":"nope"}', 'utf-8');
    expect(getBrowserPreferences(file).userAgentPresets).toEqual([]);
  });

  it('persists Browser history and download records', () => {
    const records = {
      history: [
        {
          id: 'history-1',
          url: 'https://example.com/',
          title: 'Example',
          visitedAt: 1_700_000_000_000,
        },
      ],
      downloads: [],
    };
    saveBrowserRecords(records, file);
    expect(getBrowserRecords(file)).toEqual(records);
  });

  it('caps persisted Browser record bytes and rejects oversized metadata', () => {
    const history = Array.from({ length: 200 }, (_, index) => ({
      id: `history-${index}`,
      url: `https://example.com/${index}/${'u'.repeat(3_900)}`,
      title: 'T'.repeat(512),
      favicon: `https://example.com/${'f'.repeat(1_900)}.ico`,
      visitedAt: 1_700_000_000_000 + index,
    }));
    saveBrowserRecords({ history, downloads: [] }, file);

    const persisted = readFileSync(file);
    expect(persisted.byteLength).toBeLessThan(400 * 1_024);
    expect(getBrowserRecords(file).history.length).toBeLessThan(200);

    writeFileSync(
      file,
      JSON.stringify({
        browserHistory: [{
          id: 'history-bad',
          url: 'https://example.com/',
          title: 'T'.repeat(513),
          favicon: `data:image/png;base64,${'A'.repeat(10_000)}`,
          visitedAt: 1,
        }],
      }),
    );
    expect(getBrowserRecords(file).history).toEqual([]);
  });

  it('reports first launch until marked, then never again (no migration)', () => {
    expect(shouldReportFirstLaunch(file)).toBe(true);
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    expect(shouldReportFirstLaunch(file)).toBe(true);

    markFirstLaunchReported(file);
    expect(shouldReportFirstLaunch(file)).toBe(false);
    expect(loadUiState(file)).toEqual({ onboarded: true, firstLaunchReported: true });

    markFirstLaunchReported(file);
    expect(shouldReportFirstLaunch(file)).toBe(false);
  });

  it('hands out the pending session continue marker once and clears it', () => {
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    const pending = { sessionIds: ['s1', 's2'], armedAt: 1_000, fromVersion: '1.4.2' };
    savePendingSessionContinue(pending, file);

    expect(takePendingSessionContinue(file)).toEqual(pending);
    expect(loadUiState(file)).toEqual({ onboarded: true });
    expect(takePendingSessionContinue(file)).toBeUndefined();
  });

  it('clears the pending session continue marker when saving nothing', () => {
    savePendingSessionContinue({ sessionIds: ['s1'], armedAt: 1_000, fromVersion: '1.4.2' }, file);
    savePendingSessionContinue(undefined, file);
    expect(takePendingSessionContinue(file)).toBeUndefined();
  });

  it('saves the pending session continue marker over a corrupt state file', () => {
    writeFileSync(file, 'not json', 'utf-8');
    const pending = { sessionIds: ['s1'], armedAt: 1_000, fromVersion: '1.4.2' };
    savePendingSessionContinue(pending, file);
    expect(takePendingSessionContinue(file)).toEqual(pending);
  });

  it('reports a pending session continue marker that cannot be written', () => {
    mkdirSync(file);
    expect(() => savePendingSessionContinue({ sessionIds: ['s1'], armedAt: 1_000, fromVersion: '1.4.2' }, file)).toThrow();
  });

  it.each([
    null,
    'armed',
    { sessionIds: 's1', armedAt: 1_000, fromVersion: '1.4.2' },
    { sessionIds: ['s1'], armedAt: 'now', fromVersion: '1.4.2' },
    { sessionIds: ['s1'], armedAt: 1_000 },
  ])('drops a malformed pending session continue marker: %j', (marker) => {
    writeFileSync(file, JSON.stringify({ onboarded: true, pendingSessionContinue: marker }), 'utf-8');
    expect(takePendingSessionContinue(file)).toBeUndefined();
    expect(loadUiState(file)).toEqual({ onboarded: true });
  });

  it('keeps only usable session ids from the pending marker', () => {
    writeFileSync(
      file,
      JSON.stringify({ pendingSessionContinue: { sessionIds: ['s1', '', 7, 's2'], armedAt: 1_000, fromVersion: '1.4.2' } }),
      'utf-8',
    );
    expect(takePendingSessionContinue(file)?.sessionIds).toEqual(['s1', 's2']);
  });

  it('treats a missing or invalid dockIconChoice as undefined', () => {
    expect(getDockIconChoice(file)).toBeUndefined();
    writeFileSync(file, 'not json', 'utf-8');
    expect(getDockIconChoice(file)).toBeUndefined();
    writeFileSync(file, '{"dockIconChoice":"auto"}', 'utf-8');
    expect(getDockIconChoice(file)).toBeUndefined();
    writeFileSync(file, '{"dockIconChoice":"blue"}', 'utf-8');
    expect(getDockIconChoice(file)).toBeUndefined();
  });

  it('saveDockIconChoice round-trips and preserves other keys', () => {
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    saveDockIconChoice('dark', file);
    expect(getDockIconChoice(file)).toBe('dark');
    expect(loadUiState(file)).toEqual({ onboarded: true, dockIconChoice: 'dark' });
    saveDockIconChoice('light', file);
    expect(getDockIconChoice(file)).toBe('light');
  });

  it('defaults mainWindowZoomLevel to 0 when missing, corrupt, or non-finite', () => {
    expect(getMainWindowZoomLevel(file)).toBe(0);
    for (const content of ['not json', 'null', '[]', '{"mainWindowZoomLevel":"1.5"}', '{"mainWindowZoomLevel":null}', '{"mainWindowZoomLevel":true}', '{"mainWindowZoomLevel":{}}', '{"mainWindowZoomLevel":1e999}']) {
      writeFileSync(file, content, 'utf-8');
      expect(getMainWindowZoomLevel(file)).toBe(0);
    }
  });

  it('round-trips mainWindowZoomLevel and preserves other keys', () => {
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    setMainWindowZoomLevel(1.5, file);
    expect(getMainWindowZoomLevel(file)).toBe(1.5);
    expect(loadUiState(file)).toEqual({ onboarded: true, mainWindowZoomLevel: 1.5 });
    setMainWindowZoomLevel(0, file);
    expect(getMainWindowZoomLevel(file)).toBe(0);
    expect(loadUiState(file)).toEqual({ onboarded: true, mainWindowZoomLevel: 0 });
  });

  it('clamps mainWindowZoomLevel on both read and write and ignores non-finite writes', () => {
    expect(clampMainWindowZoomLevel(-12)).toBe(-6);
    expect(clampMainWindowZoomLevel(12)).toBe(6);
    writeFileSync(file, '{"mainWindowZoomLevel":42}', 'utf-8');
    expect(getMainWindowZoomLevel(file)).toBe(6);
    writeFileSync(file, '{"mainWindowZoomLevel":-42}', 'utf-8');
    expect(getMainWindowZoomLevel(file)).toBe(-6);
    setMainWindowZoomLevel(2, file);
    setMainWindowZoomLevel(Number.NaN, file);
    setMainWindowZoomLevel(Number.POSITIVE_INFINITY, file);
    expect(getMainWindowZoomLevel(file)).toBe(2);
    setMainWindowZoomLevel(99, file);
    expect(getMainWindowZoomLevel(file)).toBe(6);
    expect(JSON.parse(readFileSync(file, 'utf-8')).mainWindowZoomLevel).toBe(6);
    setMainWindowZoomLevel(-99, file);
    expect(getMainWindowZoomLevel(file)).toBe(-6);
    expect(JSON.parse(readFileSync(file, 'utf-8')).mainWindowZoomLevel).toBe(-6);
  });

  it('skips rewriting ui-state when the clamped mainWindowZoomLevel is unchanged', () => {
    writeFileSync(file, '{"onboarded":true,"mainWindowZoomLevel":0}', 'utf-8');
    const before = readFileSync(file, 'utf-8');
    setMainWindowZoomLevel(0, file);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});
