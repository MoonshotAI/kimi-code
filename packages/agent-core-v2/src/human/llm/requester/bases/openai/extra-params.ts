export interface OpenAIExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop?: string | readonly string[];
  readonly n?: number;
  readonly seed?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly logit_bias?: Record<string, number>;
  readonly logprobs?: boolean;
  readonly top_logprobs?: number;
  readonly parallel_tool_calls?: boolean;
  readonly service_tier?: string;
  readonly user?: string;
  readonly extra_body?: Record<string, unknown>;
}
