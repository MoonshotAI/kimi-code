import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PROMPT_PREDICTION_FLAG_ID = 'prompt_prediction';
export const PROMPT_PREDICTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION';
export const PROMPT_PREDICTION_TIMEOUT_MS = 20_000;
export const PROMPT_PREDICTION_MAX_UNCACHED_INPUT_TOKENS = 10_000;
export const PROMPT_PREDICTION_MAX_OUTPUT_TOKENS = 512;
export const PROMPT_PREDICTION_MAX_CHARS = 2_000;

export const PROMPT_PREDICTION_INSTRUCTION = `[SUGGESTION MODE: Suggest what the user might naturally type next to the main agent.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code is written → "try it out"
The main agent offers options → suggest the one the user would likely pick, based on the conversation
The main agent asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After an error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate, including sensitive topics such as security incidents, credentials, harm, or private data. Even when the user is doing legitimate security work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style and language. Or nothing.

Reply with ONLY one suggestion as plain text, no quotes or explanation. Do not call any tools.`;

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
  'plan',
  'visibility',
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
