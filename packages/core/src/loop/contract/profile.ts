/**
 * Loop profile: the system prompt and tool descriptions sent with every request.
 */
import type { ToolDescription } from '#/llm/message';

export interface LoopProfile {
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
}
