export interface AnthropicExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop_sequences?: readonly string[];
}
