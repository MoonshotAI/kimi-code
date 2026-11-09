import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PROMPT_PREDICTION_FLAG_ID = 'prompt_prediction';
export const PROMPT_PREDICTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION';
export const PROMPT_PREDICTION_TIMEOUT_MS = 10_000;
export const PROMPT_PREDICTION_MAX_UNCACHED_INPUT_TOKENS = 10_000;
export const PROMPT_PREDICTION_MAX_OUTPUT_TOKENS = 512;
export const PROMPT_PREDICTION_MAX_CHARS = 2_000;

export const PROMPT_PREDICTION_INSTRUCTION = `Predict the user's next prompt to the main agent from the conversation so far.
Return exactly one useful, concrete prompt as plain text and nothing else.
Do not answer the prompt, explain the prediction, quote it, or call any tools.
Keep it short and write it in the user's language.`;

export const promptPredictionFlag: FlagDefinitionInput = {
  id: PROMPT_PREDICTION_FLAG_ID,
  title: 'Prompt prediction',
  description: 'Predict the next prompt after a completed main-agent turn while the session is idle.',
  env: PROMPT_PREDICTION_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(promptPredictionFlag);

export const PROMPT_PREDICTION_CANCEL_REASONS = [
  'input',
  'escape',
  'new_turn',
  'session',
  'dialog',
  'queue',
  'submit',
  'shutdown',
  'disconnect',
  'activity_turn_started',
  'activity_turn_ended',
  'activity_background',
  'activity_interaction',
  'activity_agent_lifecycle',
  'agent_will_close',
  'agent_replaced',
  'agent_closed',
  'disposed',
  'unspecified',
] as const;

export type PromptPredictionCancelReason = typeof PROMPT_PREDICTION_CANCEL_REASONS[number];

export interface PromptPredictionInput {
  readonly predictionId: string;
  readonly expectedTurnId: number;
}

export interface ISessionPromptPredictionService {
  readonly _serviceBrand: undefined;

  predict(input: PromptPredictionInput): Promise<string | null>;

  cancel(predictionId: string, reason?: PromptPredictionCancelReason): boolean;
}

export const ISessionPromptPredictionService: ServiceIdentifier<ISessionPromptPredictionService> =
  createDecorator<ISessionPromptPredictionService>('sessionPromptPredictionService');
