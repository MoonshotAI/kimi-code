// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { workspaceFolders } from '../src/client/workspaceFolders';
import { loadSessionInfoPanelEnabled, saveSessionInfoPanelEnabled, STORAGE_KEYS } from '../src/lib/storage';

describe('workspaceFolders', () => {
  it('puts the primary root first and preserves additional directory order', () => {
    expect(workspaceFolders({ root: '/repo', additionalDirs: ['/docs', '/packages'] })).toEqual([
      { path: '/repo', primary: true },
      { path: '/docs', primary: false },
      { path: '/packages', primary: false },
    ]);
  });

  it('keeps the first spelling of Windows folders and distinguishes POSIX case', () => {
    expect(workspaceFolders({
      root: 'C:\\Repo', additionalDirs: ['c:/repo/', '\\\\Host\\Share\\Docs', '//host/share/docs/', '/Data', '/data'],
    })).toEqual([
      { path: 'C:\\Repo', primary: true },
      { path: '\\\\Host\\Share\\Docs', primary: false },
      { path: '/Data', primary: false },
      { path: '/data', primary: false },
    ]);
  });

  it('returns only the primary root when there are no additional directories', () => {
    expect(workspaceFolders({ root: '/repo' })).toEqual([{ path: '/repo', primary: true }]);
    expect(workspaceFolders({ root: '', additionalDirs: ['/docs'] })).toEqual([]);
  });
});

describe('session info panel preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to enabled when missing or invalid', () => {
    expect(loadSessionInfoPanelEnabled()).toBe(true);
    localStorage.setItem(STORAGE_KEYS.sessionInfoPanel, 'null');
    expect(loadSessionInfoPanelEnabled()).toBe(true);
    localStorage.setItem(STORAGE_KEYS.sessionInfoPanel, '"unexpected"');
    expect(loadSessionInfoPanelEnabled()).toBe(true);
  });

  it('persists only an explicit boolean preference', () => {
    saveSessionInfoPanelEnabled(false);
    expect(loadSessionInfoPanelEnabled()).toBe(false);
    saveSessionInfoPanelEnabled(true);
    expect(loadSessionInfoPanelEnabled()).toBe(true);
  });
});
