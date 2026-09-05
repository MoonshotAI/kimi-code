export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  raw?: Record<string, unknown>;
}

export function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}
