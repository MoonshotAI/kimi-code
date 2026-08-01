import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isOnboarded, isUpdateAutoDownloadEnabled, isVibrancyEnabled, getDockIconChoice, loadUiState, markFirstLaunchReported, markOnboarded, saveDockIconChoice, setUpdateAutoDownloadEnabled, setVibrancyEnabled, shouldReportFirstLaunch } from '../../src/main/ui-state';

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

  it('reports first launch until marked, then never again (no migration)', () => {
    // Missing file → report. A legacy ui-state without the marker also reports
    // (upgraded installs re-report once — accepted noise, no migration).
    expect(shouldReportFirstLaunch(file)).toBe(true);
    writeFileSync(file, '{"onboarded":true}', 'utf-8');
    expect(shouldReportFirstLaunch(file)).toBe(true);

    markFirstLaunchReported(file);
    expect(shouldReportFirstLaunch(file)).toBe(false);
    expect(loadUiState(file)).toEqual({ onboarded: true, firstLaunchReported: true });

    // Idempotent: marking again keeps the flag and other keys.
    markFirstLaunchReported(file);
    expect(shouldReportFirstLaunch(file)).toBe(false);
  });

  it('treats a missing or invalid dockIconChoice as undefined', () => {
    expect(getDockIconChoice(file)).toBeUndefined();
    writeFileSync(file, 'not json', 'utf-8');
    expect(getDockIconChoice(file)).toBeUndefined();
    writeFileSync(file, '{"dockIconChoice":"auto"}', 'utf-8'); // retired value
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
});
