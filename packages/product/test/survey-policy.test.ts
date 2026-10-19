import { describe, expect, it, vi } from 'vitest';

import {
  buildSurveyEventProperties,
  SURVEY_EVENT_NAMES,
  surveyEventDefinitions,
  type SurveyEventEnvironmentFields,
} from '#/session-rating/node/event-properties';
import {
  evaluateLongContextArm,
  evaluateSurveyGate,
  type LongContextArmGateInput,
  type SessionArmGateInput,
  type SurveyGateInput,
} from '#/session-rating/common/gates';
import {
  DEFAULT_SURVEY_POPUP_CONFIG,
  type SurveyPopupConfig,
} from '#/session-rating/common/survey-popup-config';

const CONFIG = DEFAULT_SURVEY_POPUP_CONFIG;

function passingSession(overrides: Partial<SessionArmGateInput> = {}): SessionArmGateInput {
  return {
    turnInProgress: false,
    feedbackSurveyDisabled: false,
    telemetryDisabled: false,
    kfcModelId: 'k3',
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
    turnInProgress: false,
    feedbackSurveyDisabled: false,
    telemetryDisabled: false,
    kfcModelId: 'k3',
    cumulativeTokens: 0,
    virtualContextTokens: 0,
    mountRollConsumed: false,
    mountSurveyShown: false,
    msSinceGlobalLastShown: undefined,
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
    [{ turnInProgress: true }, 'turn-in-progress'],
    [{ feedbackSurveyDisabled: true }, 'feature-disabled'],
    [{ telemetryDisabled: true }, 'telemetry-disabled'],
    [{ mountedForMs: 599_999 }, 'warmup'],
    [{ userTurnsSinceMount: 4 }, 'warmup'],
    [{ sample: 0.006 }, 'sampled-out'],
    [{ msSinceGlobalLastShown: 99_999_999 }, 'global-cooldown'],
  ])('skips with %j → %s', (overrides, reason) => {
    expect(evaluateSurveyGate(gate(overrides))).toEqual({ show: false, reason });
  });

  it('applies the chain in order: a running turn reports turn-in-progress, not later reasons', () => {
    expect(
      evaluateSurveyGate(gate({ turnInProgress: true, telemetryDisabled: true })),
    ).toEqual({ show: false, reason: 'turn-in-progress' });
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
    it('opens for everything with "*", even without a resolved kfc id', () => {
      expect(evaluateSurveyGate(gate({ kfcModelId: 'anything' })).show).toBe(true);
      expect(evaluateSurveyGate(gate({ kfcModelId: undefined })).show).toBe(true);
    });

    it('closes both arms with an empty list', () => {
      expect(evaluateSurveyGate(gate({}, { ...CONFIG, on_for_models: [] }))).toEqual({
        show: false,
        reason: 'model-gated',
      });
    });

    it('requires a resolved kfc id that exactly matches otherwise', () => {
      const config = { ...CONFIG, on_for_models: ['k3'] };
      expect(evaluateSurveyGate(gate({ kfcModelId: 'k3' }, config)).show).toBe(true);
      expect(evaluateSurveyGate(gate({ kfcModelId: 'k2' }, config))).toEqual({
        show: false,
        reason: 'model-gated',
      });
      expect(evaluateSurveyGate(gate({ kfcModelId: undefined }, config))).toEqual({
        show: false,
        reason: 'model-gated',
      });
      expect(evaluateSurveyGate(gate({ kfcModelId: 'k3-fictional' }, config))).toEqual({
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
  const ELIGIBLE: Partial<LongContextArmGateInput> = { virtualContextTokens: 250_000 };

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
    [{ mountSurveyShown: true }, 'mount-survey-shown'],
    [{ turnInProgress: true }, 'turn-in-progress'],
    [{ feedbackSurveyDisabled: true }, 'feature-disabled'],
    [{ telemetryDisabled: true }, 'telemetry-disabled'],
    [{ virtualContextTokens: 199_999 }, 'below-threshold'],
    [{ msSinceGlobalLastShown: 99_999_999 }, 'global-cooldown'],
  ])('skips with %j → %s', (overrides, reason) => {
    expect(arm(overrides)).toEqual({ show: false, reason });
  });

  it('checks the mount cap first: a shown survey reports mount-survey-shown, not later reasons', () => {
    expect(arm({ mountSurveyShown: true, mountRollConsumed: true })).toEqual({
      show: false,
      reason: 'mount-survey-shown',
    });
  });

  it('checks the mount latch first: a spent roll reports mount-roll-consumed, not later reasons', () => {
    expect(arm({ mountRollConsumed: true, telemetryDisabled: true })).toEqual({
      show: false,
      reason: 'mount-roll-consumed',
    });
  });

  it('applies the chain in order: a running turn reports turn-in-progress, not later reasons', () => {
    expect(arm({ turnInProgress: true, telemetryDisabled: true })).toEqual({
      show: false,
      reason: 'turn-in-progress',
    });
  });

  it('applies the model gate before the threshold', () => {
    expect(arm({}, { ...CONFIG, on_for_models: [], long_context_survey_threshold: 0 })).toEqual({
      show: false,
      reason: 'model-gated',
    });
    expect(arm({ kfcModelId: undefined }, { ...CONFIG, on_for_models: ['k3'] })).toEqual({
      show: false,
      reason: 'model-gated',
    });
  });

  it('shows at the counter boundary (counter == threshold)', () => {
    expect(arm({ virtualContextTokens: 200_000 })).toEqual({
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
      expect(arm({ virtualContextTokens: 199_999, drawMountRoll })).toEqual({
        show: false,
        reason: 'below-threshold',
      });
      expect(drawMountRoll).not.toHaveBeenCalled();
    });

    it('does not draw the dice inside the shared global cooldown, so the roll stays unspent', () => {
      const drawMountRoll = vi.fn(() => 0);
      expect(arm({ msSinceGlobalLastShown: 1000, drawMountRoll })).toEqual({
        show: false,
        reason: 'global-cooldown',
      });
      expect(drawMountRoll).not.toHaveBeenCalled();
    });

    it('shows once the shared global cooldown has elapsed', () => {
      expect(arm({ msSinceGlobalLastShown: 100_000_000 })).toEqual({
        show: true,
        survey: 'long_context',
        longContextRollConsumed: true,
      });
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
      expect(arm({ virtualContextTokens: 199_999 })).toEqual({
        show: false,
        reason: 'below-threshold',
      });
      expect(arm({ virtualContextTokens: 200_000 })).toEqual({
        show: true,
        survey: 'long_context',
        longContextRollConsumed: true,
      });
    });
  });

  describe('counter mode', () => {
    it('compares the window occupancy by default and ignores the cumulative counter', () => {
      expect(arm({ cumulativeTokens: 500_000, virtualContextTokens: 199_999 })).toEqual({
        show: false,
        reason: 'below-threshold',
      });
      expect(arm({ cumulativeTokens: 0, virtualContextTokens: 200_000 })).toEqual({
        show: true,
        survey: 'long_context',
        longContextRollConsumed: true,
      });
    });

    it('compares the cumulative counter when the trigger mode is cumulative', () => {
      const config = { ...CONFIG, long_context_trigger_mode: 'cumulative' as const };
      expect(arm({ cumulativeTokens: 250_000, virtualContextTokens: 0 }, config)).toEqual({
        show: true,
        survey: 'long_context',
        longContextRollConsumed: true,
      });
      expect(arm({ cumulativeTokens: 100, virtualContextTokens: 500_000 }, config)).toEqual({
        show: false,
        reason: 'below-threshold',
      });
    });
  });
});

describe('evaluateSurveyGate (arbitration)', () => {
  const ELIGIBLE: Partial<LongContextArmGateInput> = { virtualContextTokens: 250_000 };

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

  it('blocks both arms inside the shared persisted cooldown', () => {
    expect(
      evaluateSurveyGate(
        gate(
          { msSinceGlobalLastShown: 1000 },
          CONFIG,
          { ...ELIGIBLE, msSinceGlobalLastShown: 1000 },
        ),
      ),
    ).toEqual({ show: false, reason: 'global-cooldown' });
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

describe('buildSurveyEventProperties', () => {
  it('retains documented survey event and property names', () => {
    expect(Object.keys(surveyEventDefinitions).toSorted()).toEqual([
      'feedback_survey', 'long_context_survey',
    ]);
    const namePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
    for (const [name, { meta }] of Object.entries(surveyEventDefinitions)) {
      expect(name).toMatch(namePattern);
      expect(meta.owner.length, `${name}: owner`).toBeGreaterThan(0);
      expect(meta.comment.length, `${name}: comment`).toBeGreaterThan(0);
      for (const [property, description] of Object.entries(meta.properties)) {
        expect(property, `${name}.${property}`).toMatch(namePattern);
        expect(description.length, `${name}.${property}: description`).toBeGreaterThan(0);
      }
    }
  });

  it('maps survey kinds to the wire event names', () => {
    expect(SURVEY_EVENT_NAMES).toEqual({
      session: 'feedback_survey',
      long_context: 'long_context_survey',
    });
  });

  const ENVIRONMENT: SurveyEventEnvironmentFields = {
    current_model: 'k2',
    kfc_model_id: 'k3',
    kfc_trace_id: 'trace-1',
    user_turn_count: 9,
    cumulative_tokens: 123,
    virtual_context_tokens: 45,
    tool_call_count: 6,
    compaction_count: 2,
    permission_mode: 'manual',
    thinking_effort: 'high',
    subagent_count: 3,
    subagent_models: 'k2,k3',
    swarm_run_count: 1,
    swarm_models: 'k2',
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
      config_long_context_trigger_mode: 'virtual_context',
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
