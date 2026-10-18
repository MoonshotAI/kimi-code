import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { applySurveyPreferenceChoice } from '#/tui/commands/config';
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

    await expect(migrateLegacySurveySetting(migration)).resolves.toBe(true);
    expect(migration.setConfig).toHaveBeenCalledWith({ disableFeedbackSurvey: true });
    expect(migration.dropLegacy).toHaveBeenCalledTimes(1);
    expect(migration.warn).not.toHaveBeenCalled();
  });

  it('keeps the config.toml value and still drops the stale tui.toml copy', async () => {
    const migration = deps(true, false);

    await expect(migrateLegacySurveySetting(migration)).resolves.toBe(false);
    expect(migration.setConfig).not.toHaveBeenCalled();
    expect(migration.dropLegacy).toHaveBeenCalledTimes(1);
  });

  it('reads config.toml alone when tui.toml has no legacy value', async () => {
    const migration = deps(undefined, true);

    await expect(migrateLegacySurveySetting(migration)).resolves.toBe(true);
    expect(migration.setConfig).not.toHaveBeenCalled();
    expect(migration.dropLegacy).not.toHaveBeenCalled();
  });

  it('keeps honoring the legacy value and retries later when config.toml cannot be written', async () => {
    const migration = deps(true, undefined);
    migration.setConfig.mockRejectedValueOnce(new Error('read-only'));

    await expect(migrateLegacySurveySetting(migration)).resolves.toBe(true);
    expect(migration.dropLegacy).not.toHaveBeenCalled();
    expect(migration.warn).toHaveBeenCalledWith(
      '[tui.toml] could not move disable_feedback_survey to config.toml; retrying on next start',
    );
  });

  it('warns when the tui.toml copy cannot be removed', async () => {
    const migration = deps(false, undefined);
    migration.dropLegacy.mockRejectedValueOnce(new Error('read-only'));

    await expect(migrateLegacySurveySetting(migration)).resolves.toBe(false);
    expect(migration.warn).toHaveBeenCalledWith(
      '[tui.toml] could not remove disable_feedback_survey after moving it to config.toml',
    );
  });
});
