import type { ToolDescription } from '#/llm/message';

export interface LoopProfile {
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
}
