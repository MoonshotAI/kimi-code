export interface OpenAIResponsesExtraParams {
  readonly temperature?: number;
  readonly top_p?: number;
  readonly include?: readonly string[];
  readonly metadata?: Record<string, string>;
  readonly parallel_tool_calls?: boolean;
  readonly service_tier?: string;
  readonly store?: boolean;
  readonly truncation?: 'auto' | 'disabled';
  readonly user?: string;
  readonly text?: { verbosity?: 'low' | 'medium' | 'high' };
  readonly reasoning?: { effort?: string; summary?: 'auto' | 'concise' | 'detailed' };
}
