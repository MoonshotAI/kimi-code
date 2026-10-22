import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { applySurveyPreferenceChoice } from '#/tui/commands/config';
import { loadTuiConfig, removeLegacySurveySetting, saveTuiConfig } from '#/tui/config';
import { migrateLegacySurveySetting } from '#/utils/survey-setting';

function makeHost(disableFeedbackSurvey: boolean) {
  return {
    state: { appState: { disableFeedbackSurvey } },
    harness: { setConfig: vi.fn(async () => ({})) },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
  };
}

describe('survey preference commands', () => {
  it('saves the opt-out to config.toml and mirrors it into appState', async () => {
    const host = makeHost(false);

    await applySurveyPreferenceChoice(host, false);

    expect(host.harness.setConfig).toHaveBeenCalledWith({ disableFeedbackSurvey: true });
    expect(host.setAppState).toHaveBeenCalledWith({ disableFeedbackSurvey: true });
    expect(host.showStatus).toHaveBeenCalledWith('Feedback survey disabled.');
  });

  it('re-enables the survey from an opt-out state', async () => {
    const host = makeHost(true);

    await applySurveyPreferenceChoice(host, true);

    expect(host.harness.setConfig).toHaveBeenCalledWith({ disableFeedbackSurvey: false });
    expect(host.setAppState).toHaveBeenCalledWith({ disableFeedbackSurvey: false });
    expect(host.showStatus).toHaveBeenCalledWith('Feedback survey enabled.');
  });

  it('does not rewrite the config when the value is unchanged', async () => {
    const host = makeHost(false);

    await applySurveyPreferenceChoice(host, true);

    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Feedback survey already enabled.');
  });

  it('reports a save failure without touching appState', async () => {
    const host = makeHost(false);
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await applySurveyPreferenceChoice(host, false);

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save session rating setting: disk full',
      'error',
    );
  });
});

describe('legacy survey setting migration', () => {
  function deps(legacyValue: boolean | undefined, configured: boolean | undefined) {
    return {
      legacyValue,
      getConfig: vi.fn(async () => ({ disableFeedbackSurvey: configured }) as KimiConfig),
      setConfig: vi.fn(async () => ({})),
      dropLegacy: vi.fn(async () => {}),
      warn: vi.fn(),
    };
  }

  it('moves a tui.toml opt-out into config.toml and drops it from tui.toml', async () => {
    const migration = deps(true, undefined);

    await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
      value: true,
      configured: undefined,
      action: 'written',
    });
    expect(migration.setConfig).toHaveBeenCalledWith({ disableFeedbackSurvey: true });
    expect(migration.dropLegacy).toHaveBeenCalledTimes(1);
    expect(migration.warn).not.toHaveBeenCalled();
  });

  it('drops a default-valued legacy setting without writing config.toml', async () => {
    const migration = deps(false, undefined);

    await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
      value: false,
      configured: undefined,
      action: 'dropped_default',
    });
    expect(migration.setConfig).not.toHaveBeenCalled();
    expect(migration.dropLegacy).toHaveBeenCalledTimes(1);
    expect(migration.warn).not.toHaveBeenCalled();
  });

  it('keeps the config.toml value and still drops the stale tui.toml copy', async () => {
    const migration = deps(true, false);

    await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
      value: false,
      configured: false,
      action: 'kept_existing',
    });
    expect(migration.setConfig).not.toHaveBeenCalled();
    expect(migration.dropLegacy).toHaveBeenCalledTimes(1);
  });

  it('keeps the config.toml value when the legacy copy holds the default', async () => {
    const migration = deps(false, true);

    await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
      value: true,
      configured: true,
      action: 'kept_existing',
    });
    expect(migration.setConfig).not.toHaveBeenCalled();
    expect(migration.dropLegacy).toHaveBeenCalledTimes(1);
  });

  it('reads config.toml alone when tui.toml has no legacy value', async () => {
    const migration = deps(undefined, true);

    await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
      value: true,
      configured: true,
    });
    expect(migration.setConfig).not.toHaveBeenCalled();
    expect(migration.dropLegacy).not.toHaveBeenCalled();
  });

  it('keeps honoring the legacy value and retries later when config.toml cannot be written', async () => {
    const migration = deps(true, undefined);
    migration.setConfig.mockRejectedValueOnce(new Error('read-only'));

    await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
      value: true,
      configured: undefined,
      action: 'write_failed',
    });
    expect(migration.dropLegacy).not.toHaveBeenCalled();
    expect(migration.warn).toHaveBeenCalledWith(
      '[tui.toml] could not move disable_feedback_survey to config.toml; retrying on next start',
    );
  });

  it('retries a failed migration after another preference has been saved', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'survey-migration-'));
    const filePath = join(directory, 'tui.toml');
    try {
      writeFileSync(filePath, 'disable_feedback_survey = true\nauto_session_title = false\n');
      const migration = deps((await loadTuiConfig(filePath)).disableFeedbackSurvey, undefined);
      migration.setConfig.mockRejectedValueOnce(new Error('read-only'));
      migration.dropLegacy.mockImplementation(() => removeLegacySurveySetting(filePath));
      await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
        value: true,
        configured: undefined,
        action: 'write_failed',
      });
      await saveTuiConfig({
        ...await loadTuiConfig(filePath), disableFeedbackSurvey: undefined, theme: 'light',
      }, filePath);
      expect(await loadTuiConfig(filePath)).toMatchObject({
        disableFeedbackSurvey: true, autoSessionTitle: false, theme: 'light',
      });
      const retry = deps((await loadTuiConfig(filePath)).disableFeedbackSurvey, undefined);
      retry.dropLegacy.mockImplementation(() => removeLegacySurveySetting(filePath));
      await expect(migrateLegacySurveySetting(retry)).resolves.toEqual({
        value: true,
        configured: undefined,
        action: 'written',
      });
      expect(retry.setConfig).toHaveBeenCalledWith({ disableFeedbackSurvey: true });
      const saved = await loadTuiConfig(filePath);
      expect(saved).toMatchObject({ autoSessionTitle: false, theme: 'light' });
      expect(saved.disableFeedbackSurvey).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('warns when the tui.toml copy cannot be removed', async () => {
    const migration = deps(false, undefined);
    migration.dropLegacy.mockRejectedValueOnce(new Error('read-only'));

    await expect(migrateLegacySurveySetting(migration)).resolves.toEqual({
      value: false,
      configured: undefined,
      action: 'dropped_default',
    });
    expect(migration.setConfig).not.toHaveBeenCalled();
    expect(migration.warn).toHaveBeenCalledWith(
      '[tui.toml] could not remove disable_feedback_survey; retrying on next start',
    );
  });
});
