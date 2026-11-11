import type { ToolDescription } from '#human/llm/message';

export interface LoopProfile {
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
}
