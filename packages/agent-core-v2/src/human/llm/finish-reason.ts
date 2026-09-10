export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface FinishInfo {
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
}

export const NO_FINISH: FinishInfo = { finishReason: null, rawFinishReason: null };
