export interface GoogleGenAIExtraParams {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly candidateCount?: number;
  readonly seed?: number;
  readonly stopSequences?: readonly string[];
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
  readonly thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number };
}
