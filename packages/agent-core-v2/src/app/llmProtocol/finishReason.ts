/**
 * `llmProtocol.finishReason` — the discrete outcome of a completion turn.
 *
 * `'completed' | 'tool_calls' | 'truncated' | 'filtered' | 'paused' | 'other'`.
 * v2's loop / turn / llmRequester domains dispatch on this rather than
 * importing the type from kosong.
 */

export type { FinishReason } from './provider';
