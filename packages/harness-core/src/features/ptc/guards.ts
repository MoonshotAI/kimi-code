import { createCollection, useContribute } from '@moonshot-ai/agent-core/kernel/index';
import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { Cause } from '@moonshot-ai/agent-core/loop/index';
import type { ToolResult } from '@moonshot-ai/agent-core/tool/index';

export interface PtcToolGuardInput {
  readonly toolCall: ToolCall;
}

export type PtcToolGuardDecision =
  | { readonly toolCall: ToolCall }
  | { readonly blocked: Cause; readonly result?: ToolResult };

export type PtcToolGuard = (
  input: PtcToolGuardInput,
  signal: AbortSignal,
) => void | PtcToolGuardDecision | Promise<void | PtcToolGuardDecision>;

export const PtcToolGuards = createCollection<PtcToolGuard>('ptc.tool-guards');

export function usePtcToolGuard(guard: PtcToolGuard): void {
  useContribute(PtcToolGuards, guard);
}
