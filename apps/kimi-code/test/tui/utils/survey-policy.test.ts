import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SURVEY_POPUP_CONFIG,
  type SurveyPopupConfig,
} from '#/utils/survey-popup-config';
import {
  buildSurveyEventProperties,
  evaluateLongContextArm,
  evaluateSurveyGate,
  SURVEY_EVENT_NAMES,
  SURVEY_MACHINE_CLOSED,
  surveyMachineReduce,
  type LongContextArmGateInput,
  type SessionArmGateInput,
  type SurveyEventEnvironmentFields,
  type SurveyGateInput,
  type SurveyMachineState,
} from '#/tui/utils/survey-policy';

const CONFIG = DEFAULT_SURVEY_POPUP_CONFIG;

function passingSession(overrides: Partial<SessionArmGateInput> = {}): SessionArmGateInput {
  return {
    phase: 'closed',
    turnInProgress: false,
    idleForMs: 2000,
    externalEditorActive: false,
    terminalWidth: 120,
    terminalHeight: 24,
    promptActive: false,
    editorBashActive: false,
    editorAutocompleteActive: false,
    feedbackSurveyDisabled: false,
    telemetryDisabled: false,
    currentModel: 'k2',
    lastUserMessageStartsOrderedList: false,
    mountedForMs: 600_000,
    userTurnsSinceMount: 5,
    msSinceLastShown: undefined,
    userTurnsSinceLastShown: undefined,
    sample: 0,
    msSinceGlobalLastShown: undefined,
    ...overrides,
  };
}

function passingLongContext(
  overrides: Partial<LongContextArmGateInput> = {},
): LongContextArmGateInput {
  return {
    phase: 'closed',
    turnInProgress: false,
    idleForMs: 2000,
    promptActive: false,
    editorBashActive: false,
    editorAutocompleteActive: false,
    externalEditorActive: false,
    terminalWidth: 120,
    terminalHeight: 24,
    feedbackSurveyDisabled: false,
    telemetryDisabled: false,
    currentModel: 'k2',
    lastUserMessageStartsOrderedList: false,
    cumulativeTokens: 0,
    virtualContextTokens: 0,
    mountRollConsumed: false,
    drawMountRoll: () => 0,
    ...overrides,
  };
}

function gate(
  sessionOverrides: Partial<SessionArmGateInput> = {},
  config: SurveyPopupConfig = CONFIG,
  longContextOverrides: Partial<LongContextArmGateInput> = {},
): SurveyGateInput {
  return {
    session: passingSession(sessionOverrides),
    longContext: passingLongContext(longContextOverrides),
    config,
  };
}

describe('evaluateSurveyGate (session arm)', () => {
  it('shows the session survey when every gate passes', () => {
    expect(evaluateSurveyGate(gate())).toEqual({ show: true, survey: 'session' });
  });

  it.each<[Partial<SessionArmGateInput>, string]>([
    [{ phase: 'open' }, 'survey-active'],
    [{ phase: 'pending' }, 'survey-active'],
    [{ phase: 'thanks' }, 'survey-active'],
    [{ turnInProgress: true }, 'turn-in-progress'],
    [{ idleForMs: 1999 }, 'idle-too-short'],
    [{ lastUserMessageStartsOrderedList: true }, 'ordered-list-ambiguity'],
    [{ promptActive: true }, 'prompt-active'],
    [{ editorBashActive: true }, 'editor-bash-active'],
    [{ editorAutocompleteActive: true }, 'editor-autocomplete-active'],
    [{ externalEditorActive: true }, 'external-editor-active'],
    [{ terminalWidth: 10 }, 'terminal-too-narrow'],
    [{ terminalHeight: 7 }, 'terminal-too-short'],
    [{ terminalWidth: 12, terminalHeight: 14 }, 'terminal-too-short'],
    [{ terminalWidth: 16, terminalHeight: 13 }, 'terminal-too-short'],
    [{ feedbackSurveyDisabled: true }, 'feature-disabled'],
    [{ telemetryDisabled: true }, 'telemetry-disabled'],
    [{ mountedForMs: 599_999 }, 'warmup'],
    [{ userTurnsSinceMount: 4 }, 'warmup'],
    [{ sample: 0.006 }, 'sampled-out'],
    [{ msSinceGlobalLastShown: 99_999_999 }, 'global-cooldown'],
  ])('skips with %j → %s', (overrides, reason) => {
    expect(evaluateSurveyGate(gate(overrides))).toEqual({ show: false, reason });
  });

  it('applies the chain in order: an open survey reports survey-active, not later reasons', () => {
    expect(
      evaluateSurveyGate(gate({ phase: 'open', turnInProgress: true, telemetryDisabled: true })),
    ).toEqual({ show: false, reason: 'survey-active' });
  });

  it('samples with a half-open test: sample below probability shows, at-or-above is out', () => {
    expect(evaluateSurveyGate(gate({ sample: 0.004_999 }))).toEqual({
      show: true,
      survey: 'session',
    });
    expect(evaluateSurveyGate(gate({ sample: 0.005 }))).toEqual({
      show: false,
      reason: 'sampled-out',
    });
    expect(evaluateSurveyGate(gate({ sample: 0 }, { ...CONFIG, probability: 0 })).show).toBe(
      false,
    );
  });

  describe('model gate', () => {
    it('opens for every model with "*"', () => {
      expect(evaluateSurveyGate(gate({ currentModel: 'anything' })).show).toBe(true);
    });

    it('closes both arms with an empty list', () => {
      expect(evaluateSurveyGate(gate({}, { ...CONFIG, on_for_models: [] }))).toEqual({
        show: false,
        reason: 'model-gated',
      });
    });

    it('requires an exact match otherwise', () => {
      const config = { ...CONFIG, on_for_models: ['k3'] };
      expect(evaluateSurveyGate(gate({ currentModel: 'k3' }, config)).show).toBe(true);
      expect(evaluateSurveyGate(gate({ currentModel: 'k2' }, config))).toEqual({
        show: false,
        reason: 'model-gated',
      });
      expect(evaluateSurveyGate(gate({ currentModel: 'k3-fictional' }, config))).toEqual({
        show: false,
        reason: 'model-gated',
      });
    });
  });

  describe('in-session pacing', () => {
    const shown = {
      msSinceLastShown: 3_600_000,
      userTurnsSinceLastShown: 10,
    } as const;

    it('requires the gap and the new turns once shown before', () => {
      expect(evaluateSurveyGate(gate(shown)).show).toBe(true);
    });

    it('skips inside the time gap', () => {
      expect(
        evaluateSurveyGate(gate({ ...shown, msSinceLastShown: 3_599_999 })),
      ).toEqual({ show: false, reason: 'pacing' });
    });

    it('skips without enough new turns', () => {
      expect(evaluateSurveyGate(gate({ ...shown, userTurnsSinceLastShown: 9 }))).toEqual({
        show: false,
        reason: 'pacing',
      });
    });
  });

  it('honours the global cooldown exactly at the boundary', () => {
    expect(evaluateSurveyGate(gate({ msSinceGlobalLastShown: 100_000_000 })).show).toBe(true);
  });
});

describe('evaluateLongContextArm', () => {
  const ELIGIBLE: Partial<LongContextArmGateInput> = { cumulativeTokens: 250_000 };

  function arm(
    overrides: Partial<LongContextArmGateInput> = {},
    config: SurveyPopupConfig = CONFIG,
  ): ReturnType<typeof evaluateLongContextArm> {
    return evaluateLongContextArm(gate({}, config, { ...ELIGIBLE, ...overrides }));
  }

  it('shows the long-context survey when the whole chain passes', () => {
    expect(arm()).toEqual({
      show: true,
      survey: 'long_context',
      longContextRollConsumed: true,
    });
  });

  it.each<[Partial<LongContextArmGateInput>, string]>([
    [{ mountRollConsumed: true }, 'mount-roll-consumed'],
    [{ phase: 'open' }, 'survey-active'],
    [{ phase: 'pending' }, 'survey-active'],
    [{ phase: 'thanks' }, 'survey-active'],
    [{ turnInProgress: true }, 'turn-in-progress'],
    [{ idleForMs: 1999 }, 'idle-too-short'],
    [{ promptActive: true }, 'prompt-active'],
    [{ editorBashActive: true }, 'editor-bash-active'],
    [{ editorAutocompleteActive: true }, 'editor-autocomplete-active'],
    [{ externalEditorActive: true }, 'external-editor-active'],
    [{ terminalWidth: 10 }, 'terminal-too-narrow'],
    [{ terminalHeight: 7 }, 'terminal-too-short'],
    [{ terminalWidth: 12, terminalHeight: 14 }, 'terminal-too-short'],
    [{ terminalWidth: 16, terminalHeight: 13 }, 'terminal-too-short'],
    [{ feedbackSurveyDisabled: true }, 'feature-disabled'],
    [{ telemetryDisabled: true }, 'telemetry-disabled'],
    [{ lastUserMessageStartsOrderedList: true }, 'ordered-list-ambiguity'],
    [{ cumulativeTokens: 199_999 }, 'below-threshold'],
  ])('skips with %j → %s', (overrides, reason) => {
    expect(arm(overrides)).toEqual({ show: false, reason });
  });

  it('checks the mount latch first: a spent roll reports mount-roll-consumed, not later reasons', () => {
    expect(arm({ mountRollConsumed: true, phase: 'open', telemetryDisabled: true })).toEqual({
      show: false,
      reason: 'mount-roll-consumed',
    });
  });

  it('applies the chain in order: an open survey reports survey-active, not later reasons', () => {
    expect(arm({ phase: 'open', telemetryDisabled: true })).toEqual({
      show: false,
      reason: 'survey-active',
    });
  });

  it('applies the model gate before the threshold', () => {
    expect(arm({}, { ...CONFIG, on_for_models: [], long_context_survey_threshold: 0 })).toEqual({
      show: false,
      reason: 'model-gated',
    });
    expect(arm({}, { ...CONFIG, on_for_models: ['k3'] })).toEqual({
      show: false,
      reason: 'model-gated',
    });
  });

  it('shows at the counter boundary (counter == threshold)', () => {
    expect(arm({ cumulativeTokens: 200_000 })).toEqual({
      show: true,
      survey: 'long_context',
      longContextRollConsumed: true,
    });
  });

  it('samples with a half-open test: roll below long_context_probability shows, at-or-above is out', () => {
    expect(arm({ drawMountRoll: () => 0.199_999 })).toEqual({
      show: true,
      survey: 'long_context',
      longContextRollConsumed: true,
    });
    expect(arm({ drawMountRoll: () => 0.2 })).toEqual({
      show: false,
      reason: 'sampled-out',
      longContextRollConsumed: true,
    });
  });

  describe('mount one-shot', () => {
    it('does not draw the dice below the threshold, so the roll stays unspent', () => {
      const drawMountRoll = vi.fn(() => 0);
      expect(arm({ cumulativeTokens: 199_999, drawMountRoll })).toEqual({
        show: false,
        reason: 'below-threshold',
      });
      expect(drawMountRoll).not.toHaveBeenCalled();
    });

    it('does not draw the dice while transiently suppressed by an active prompt', () => {
      const drawMountRoll = vi.fn(() => 0);
      expect(arm({ promptActive: true, drawMountRoll })).toEqual({
        show: false,
        reason: 'prompt-active',
      });
      expect(drawMountRoll).not.toHaveBeenCalled();
    });

    it('spends the roll on a miss: the arm stays silent for the rest of the mount', () => {
      expect(arm({ drawMountRoll: () => 0.9 })).toEqual({
        show: false,
        reason: 'sampled-out',
        longContextRollConsumed: true,
      });
    });

    it('spends the roll on a hit and shows once', () => {
      expect(arm({ drawMountRoll: () => 0.1 })).toEqual({
        show: true,
        survey: 'long_context',
        longContextRollConsumed: true,
      });
    });

    it('never draws again once the roll is spent', () => {
      const drawMountRoll = vi.fn(() => 0);
      expect(arm({ mountRollConsumed: true, drawMountRoll })).toEqual({
        show: false,
        reason: 'mount-roll-consumed',
      });
      expect(drawMountRoll).not.toHaveBeenCalled();
    });
  });

  describe('threshold validity', () => {
    it.each([0, -1, Number.NaN])('closes the arm on a non-positive threshold (%s)', (threshold) => {
      expect(arm({}, { ...CONFIG, long_context_survey_threshold: threshold })).toEqual({
        show: false,
        reason: 'threshold-invalid',
      });
    });

    it('runs on the built-in 200k default when the field never took a cloud value', () => {
      expect(arm({ cumulativeTokens: 199_999 })).toEqual({ show: false, reason: 'below-threshold' });
      expect(arm({ cumulativeTokens: 200_000 })).toEqual({
        show: true,
        survey: 'long_context',
        longContextRollConsumed: true,
      });
    });
  });

  describe('counter mode', () => {
    it('compares the cumulative counter by default and ignores the window occupancy', () => {
      expect(arm({ cumulativeTokens: 199_999, virtualContextTokens: 500_000 })).toEqual({
        show: false,
        reason: 'below-threshold',
      });
    });

    it('compares the window occupancy when the trigger mode is virtual_context', () => {
      const config = { ...CONFIG, long_context_trigger_mode: 'virtual_context' as const };
      expect(arm({ cumulativeTokens: 0, virtualContextTokens: 250_000 }, config)).toEqual({
        show: true,
        survey: 'long_context',
        longContextRollConsumed: true,
      });
      expect(arm({ cumulativeTokens: 500_000, virtualContextTokens: 100 }, config)).toEqual({
        show: false,
        reason: 'below-threshold',
      });
    });
  });
});

describe('evaluateSurveyGate (arbitration)', () => {
  const ELIGIBLE: Partial<LongContextArmGateInput> = { cumulativeTokens: 250_000 };

  it('prefers the long-context survey when both arms pass', () => {
    expect(evaluateSurveyGate(gate({}, CONFIG, ELIGIBLE))).toEqual({
      show: true,
      survey: 'long_context',
      longContextRollConsumed: true,
    });
  });

  it('falls back to the session arm when the long-context arm is below the threshold', () => {
    expect(evaluateSurveyGate(gate())).toEqual({ show: true, survey: 'session' });
  });

  it('falls back to the session arm when the long-context arm misses its roll, latching it spent', () => {
    expect(
      evaluateSurveyGate(gate({ sample: 0 }, CONFIG, { ...ELIGIBLE, drawMountRoll: () => 0.9 })),
    ).toEqual({
      show: true,
      survey: 'session',
      longContextRollConsumed: true,
    });
  });

  it('falls back to the session arm when the threshold closes the long-context arm', () => {
    expect(
      evaluateSurveyGate(gate({}, { ...CONFIG, long_context_survey_threshold: 0 }, ELIGIBLE)),
    ).toEqual({ show: true, survey: 'session' });
  });

  it('shows the long-context survey even when the session arm is sampled out', () => {
    expect(evaluateSurveyGate(gate({ sample: 0.9 }, CONFIG, ELIGIBLE))).toEqual({
      show: true,
      survey: 'long_context',
      longContextRollConsumed: true,
    });
  });

  it('shows the long-context survey inside the persisted cooldown that still gates the session arm', () => {
    expect(
      evaluateSurveyGate(gate({ msSinceGlobalLastShown: 1000 }, CONFIG, ELIGIBLE)),
    ).toEqual({
      show: true,
      survey: 'long_context',
      longContextRollConsumed: true,
    });
  });

  it('shows nothing when the long-context arm is ineligible and the session arm is sampled out', () => {
    expect(evaluateSurveyGate(gate({ sample: 0.9 }))).toEqual({
      show: false,
      reason: 'sampled-out',
    });
  });

  it('reports the spent roll even when both arms lose', () => {
    expect(
      evaluateSurveyGate(
        gate({ sample: 0.9 }, CONFIG, { ...ELIGIBLE, drawMountRoll: () => 0.9 }),
      ),
    ).toEqual({
      show: false,
      reason: 'sampled-out',
      longContextRollConsumed: true,
    });
  });
});

describe('surveyMachineReduce', () => {
  const appearance = { survey: 'session' as const, appearanceId: 'a1', appearanceIndex: 1 };
  const openState: SurveyMachineState = { phase: 'open', appearance, response: undefined };

  it('walks the happy path: closed → open → pending → thanks → closed', () => {
    const opened = surveyMachineReduce(SURVEY_MACHINE_CLOSED, { type: 'open', appearance });
    expect(opened.state.phase).toBe('open');
    expect(opened.effects).toEqual([{ type: 'report', eventType: 'appeared' }]);

    const selected = surveyMachineReduce(opened.state, { type: 'select', response: 'bad' });
    expect(selected.state).toEqual({ phase: 'pending', appearance, response: 'bad' });
    expect(selected.effects).toEqual([{ type: 'schedule', timer: 'pending-settle' }]);

    const settled = surveyMachineReduce(selected.state, { type: 'settle' });
    expect(settled.state.phase).toBe('thanks');
    expect(settled.effects).toEqual([
      { type: 'report', eventType: 'responded', response: 'bad' },
      { type: 'schedule', timer: 'thanks-close' },
    ]);

    const closed = surveyMachineReduce(settled.state, { type: 'thanks-elapsed' });
    expect(closed.state).toEqual(SURVEY_MACHINE_CLOSED);
    expect(closed.effects).toEqual([]);
  });

  it('undo returns pending to open without reporting, and settle after an undo reports only the final choice', () => {
    const selected = surveyMachineReduce(openState, { type: 'select', response: 'fine' });
    const undone = surveyMachineReduce(selected.state, { type: 'undo' });
    expect(undone.state).toEqual(openState);
    expect(undone.effects).toEqual([]);

    const reselected = surveyMachineReduce(undone.state, { type: 'select', response: 'good' });
    const settled = surveyMachineReduce(reselected.state, { type: 'settle' });
    expect(settled.effects).toEqual([
      { type: 'report', eventType: 'responded', response: 'good' },
      { type: 'schedule', timer: 'thanks-close' },
    ]);
  });

  it('dismiss reports responded dismissed and closes without thanks', () => {
    const dismissed = surveyMachineReduce(openState, { type: 'dismiss' });
    expect(dismissed.state).toEqual(SURVEY_MACHINE_CLOSED);
    expect(dismissed.effects).toEqual([
      { type: 'report', eventType: 'responded', response: 'dismissed' },
    ]);
  });

  it('abandon reports abandoned and closes', () => {
    const abandoned = surveyMachineReduce(openState, { type: 'abandon' });
    expect(abandoned.state).toEqual(SURVEY_MACHINE_CLOSED);
    expect(abandoned.effects).toEqual([{ type: 'report', eventType: 'abandoned' }]);
  });

  it.each(['open', 'thanks'] as const)('close-silently from %s reports nothing', (phase) => {
    const state: SurveyMachineState = { phase, appearance, response: 'good' };
    const closed = surveyMachineReduce(state, { type: 'close-silently' });
    expect(closed.state).toEqual(SURVEY_MACHINE_CLOSED);
    expect(closed.effects).toEqual([]);
  });

  it('close-silently from pending settles the un-undone choice before closing', () => {
    const state: SurveyMachineState = { phase: 'pending', appearance, response: 'bad' };
    const closed = surveyMachineReduce(state, { type: 'close-silently' });
    expect(closed.state).toEqual(SURVEY_MACHINE_CLOSED);
    expect(closed.effects).toEqual([
      { type: 'report', eventType: 'responded', response: 'bad' },
    ]);
  });

  it.each([
    [{ type: 'select', response: 'good' } as const],
    [{ type: 'dismiss' } as const],
    [{ type: 'abandon' } as const],
    [{ type: 'undo' } as const],
    [{ type: 'settle' } as const],
    [{ type: 'thanks-elapsed' } as const],
  ])('ignores %s while closed', (action) => {
    const result = surveyMachineReduce(SURVEY_MACHINE_CLOSED, action);
    expect(result.state).toEqual(SURVEY_MACHINE_CLOSED);
    expect(result.effects).toEqual([]);
  });

  describe('takeover', () => {
    const longContextAppearance = {
      survey: 'long_context' as const,
      appearanceId: 'a2',
      appearanceIndex: 2,
    };

    it('a long-context survey takes over an open session survey silently', () => {
      const result = surveyMachineReduce(openState, {
        type: 'open',
        appearance: longContextAppearance,
      });
      expect(result.state).toEqual({
        phase: 'open',
        appearance: longContextAppearance,
        response: undefined,
      });
      expect(result.effects).toEqual([{ type: 'report', eventType: 'appeared' }]);
    });

    it('a session survey never takes over an open long-context survey', () => {
      const longOpen: SurveyMachineState = {
        phase: 'open',
        appearance: longContextAppearance,
        response: undefined,
      };
      const result = surveyMachineReduce(longOpen, { type: 'open', appearance });
      expect(result.state).toEqual(longOpen);
      expect(result.effects).toEqual([]);
    });

    it('ignores a re-open of the same survey while open (no double appearance)', () => {
      const other = { survey: 'session' as const, appearanceId: 'a9', appearanceIndex: 3 };
      const result = surveyMachineReduce(openState, { type: 'open', appearance: other });
      expect(result.state).toEqual(openState);
      expect(result.effects).toEqual([]);
    });

    it.each(['pending', 'thanks'] as const)('ignores a takeover while %s', (phase) => {
      const state: SurveyMachineState = { phase, appearance, response: 'good' };
      const result = surveyMachineReduce(state, {
        type: 'open',
        appearance: longContextAppearance,
      });
      expect(result.state).toEqual(state);
      expect(result.effects).toEqual([]);
    });
  });
});

describe('buildSurveyEventProperties', () => {
  it('maps survey kinds to the wire event names', () => {
    expect(SURVEY_EVENT_NAMES).toEqual({
      session: 'feedback_survey',
      long_context: 'long_context_survey',
    });
  });

  const ENVIRONMENT: SurveyEventEnvironmentFields = {
    current_model: 'k2',
    user_turn_count: 9,
    cumulative_tokens: 123,
    virtual_context_tokens: 45,
    tool_call_count: 6,
    compaction_count: 2,
    permission_mode: 'manual',
    thinking_effort: 'high',
  };

  it('builds the core three-state fields', () => {
    expect(
      buildSurveyEventProperties(
        {
          event_type: 'responded',
          appearance_id: 'a1',
          appearance_index: 2,
          response: 'fine',
        },
        ENVIRONMENT,
        CONFIG,
      ),
    ).toEqual({
      event_type: 'responded',
      appearance_id: 'a1',
      appearance_index: 2,
      response: 'fine',
      ...ENVIRONMENT,
      config_probability: 0.005,
      config_on_for_models: '*',
      config_min_time_before_feedback_ms: 600_000,
      config_min_user_turns_before_feedback: 5,
      config_min_time_between_feedback_ms: 3_600_000,
      config_min_user_turns_between_feedback: 10,
      config_min_time_between_global_feedback_ms: 100_000_000,
      config_long_context_survey_threshold: 200_000,
      config_long_context_probability: 0.2,
      config_long_context_trigger_mode: 'cumulative',
    });
  });

  it('leaves response undefined for appeared / abandoned', () => {
    const properties = buildSurveyEventProperties(
      {
        event_type: 'appeared',
        appearance_id: 'a1',
        appearance_index: 1,
      },
      ENVIRONMENT,
      CONFIG,
    );
    expect(properties['response']).toBeUndefined();
  });

  it('flattens the effective config into primitive config_* properties', () => {
    const properties = buildSurveyEventProperties(
      {
        event_type: 'appeared',
        appearance_id: 'a1',
        appearance_index: 1,
      },
      ENVIRONMENT,
      { ...CONFIG, probability: 0.5, on_for_models: ['k3', 'k2'] },
    );
    expect(properties['config_probability']).toBe(0.5);
    expect(properties['config_on_for_models']).toBe('k3,k2');
  });

  it('keeps every property a telemetry primitive so sanitize drops nothing', () => {
    const properties = buildSurveyEventProperties(
      {
        event_type: 'responded',
        appearance_id: 'a1',
        appearance_index: 1,
        response: 'bad',
      },
      ENVIRONMENT,
      { ...CONFIG, on_for_models: [] },
    );
    for (const [key, value] of Object.entries(properties)) {
      const isPrimitive =
        value === undefined ||
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'number' ||
        typeof value === 'string';
      expect(isPrimitive, `property ${key} is not a primitive`).toBe(true);
    }
    expect(properties['config_on_for_models']).toBe('');
  });
});
