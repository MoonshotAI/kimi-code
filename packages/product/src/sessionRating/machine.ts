export type SurveyKind = 'session' | 'long_context';

export type SurveyPhase = 'closed' | 'open' | 'pending' | 'thanks';

export type RatingResponse = 'bad' | 'fine' | 'good';

export type SurveyResponse = RatingResponse | 'dismissed';

export type SurveyEventType = 'appeared' | 'responded' | 'abandoned';

export interface SurveyAppearance {
  readonly survey: SurveyKind;
  readonly appearanceId: string;
  readonly appearanceIndex: number;
}

export interface SurveyMachineState {
  readonly phase: SurveyPhase;
  readonly appearance: SurveyAppearance | undefined;
  readonly response: SurveyResponse | undefined;
}

export const SURVEY_MACHINE_CLOSED: SurveyMachineState = {
  phase: 'closed',
  appearance: undefined,
  response: undefined,
};

const SURVEY_PRIORITY: Record<SurveyKind, number> = { session: 0, long_context: 1 };

export type SurveyMachineAction =
  | { readonly type: 'open'; readonly appearance: SurveyAppearance }
  | { readonly type: 'select'; readonly response: RatingResponse }
  | { readonly type: 'dismiss' }
  | { readonly type: 'undo' }
  | { readonly type: 'settle' }
  | { readonly type: 'thanks-elapsed' }
  | { readonly type: 'abandon' }
  | { readonly type: 'close-silently' };

export type SurveyMachineEffect =
  | {
      readonly type: 'report';
      readonly eventType: SurveyEventType;
      readonly response?: SurveyResponse;
    }
  | { readonly type: 'schedule'; readonly timer: 'pending-settle' | 'thanks-close' };

export interface SurveyMachineTransition {
  readonly state: SurveyMachineState;
  readonly effects: readonly SurveyMachineEffect[];
}

const NO_EFFECTS: readonly SurveyMachineEffect[] = [];

function noTransition(state: SurveyMachineState): SurveyMachineTransition {
  return { state, effects: NO_EFFECTS };
}

export function surveyMachineReduce(
  state: SurveyMachineState,
  action: SurveyMachineAction,
): SurveyMachineTransition {
  switch (action.type) {
    case 'open': {
      if (state.phase === 'closed') {
        return {
          state: { phase: 'open', appearance: action.appearance, response: undefined },
          effects: [{ type: 'report', eventType: 'appeared' }],
        };
      }
      if (state.phase !== 'open' || state.appearance === undefined) {
        return noTransition(state);
      }
      if (SURVEY_PRIORITY[action.appearance.survey] <= SURVEY_PRIORITY[state.appearance.survey]) {
        return noTransition(state);
      }
      return {
        state: { phase: 'open', appearance: action.appearance, response: undefined },
        effects: [{ type: 'report', eventType: 'appeared' }],
      };
    }
    case 'select': {
      if (state.phase !== 'open') return noTransition(state);
      return {
        state: { ...state, phase: 'pending', response: action.response },
        effects: [{ type: 'schedule', timer: 'pending-settle' }],
      };
    }
    case 'dismiss': {
      if (state.phase !== 'open') return noTransition(state);
      return {
        state: SURVEY_MACHINE_CLOSED,
        effects: [{ type: 'report', eventType: 'responded', response: 'dismissed' }],
      };
    }
    case 'undo': {
      if (state.phase !== 'pending') return noTransition(state);
      return {
        state: { ...state, phase: 'open', response: undefined },
        effects: NO_EFFECTS,
      };
    }
    case 'settle': {
      if (state.phase !== 'pending' || state.response === undefined) {
        return noTransition(state);
      }
      return {
        state: { ...state, phase: 'thanks' },
        effects: [
          { type: 'report', eventType: 'responded', response: state.response },
          { type: 'schedule', timer: 'thanks-close' },
        ],
      };
    }
    case 'thanks-elapsed': {
      if (state.phase !== 'thanks') return noTransition(state);
      return { state: SURVEY_MACHINE_CLOSED, effects: NO_EFFECTS };
    }
    case 'abandon': {
      if (state.phase !== 'open') return noTransition(state);
      return {
        state: SURVEY_MACHINE_CLOSED,
        effects: [{ type: 'report', eventType: 'abandoned' }],
      };
    }
    case 'close-silently': {
      if (state.phase === 'closed') return noTransition(state);
      if (state.phase === 'pending' && state.response !== undefined) {
        return {
          state: SURVEY_MACHINE_CLOSED,
          effects: [{ type: 'report', eventType: 'responded', response: state.response }],
        };
      }
      return { state: SURVEY_MACHINE_CLOSED, effects: NO_EFFECTS };
    }
  }
}
