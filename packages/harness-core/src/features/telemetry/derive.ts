import { extractText } from '@moonshot-ai/agent-core/llm/message';
import type {
  AsyncToolOutcome,
  ToolCallOutcome,
  TurnOutcome,
} from '@moonshot-ai/agent-core/loop/index';
import type { ToolEntry } from '@moonshot-ai/agent-core/history/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import { useLoopEvent } from '#/runtime/index';

import type { TelemetryFace } from './feature';

interface TrackedTool {
  readonly name: string;
  readonly startedAt: number;
}

type ToolCallOutcomeKind = 'success' | 'error' | 'cancelled';

function toolEntryOutcomeOf(entry: ToolEntry): {
  outcome: ToolCallOutcomeKind;
  errorType?: 'cancelled' | 'error';
} {
  if (entry.meta?.isError !== true) return { outcome: 'success' };
  const text = extractText(entry.message).toLowerCase();
  const outcome =
    text.includes('aborted') || text.includes('cancelled') || text.includes('manually interrupted')
      ? 'cancelled'
      : 'error';
  return { outcome, errorType: outcome === 'cancelled' ? 'cancelled' : 'error' };
}

function toolCallOutcomeOf(outcome: ToolCallOutcome): {
  outcome: ToolCallOutcomeKind;
  errorType?: 'cancelled' | 'error';
} {
  switch (outcome.type) {
    case 'failed':
      return { outcome: 'error', errorType: 'error' };
    case 'aborted':
      return { outcome: 'cancelled', errorType: 'cancelled' };
    case 'succeeded':
    case 'blocked':
      return toolEntryOutcomeOf(outcome.entry);
  }
}

function asyncToolOutcomeOf(outcome: AsyncToolOutcome): {
  outcome: ToolCallOutcomeKind;
  errorType?: 'cancelled' | 'error';
} {
  switch (outcome.type) {
    case 'succeeded':
      return { outcome: 'success' };
    case 'failed':
      return { outcome: 'error', errorType: 'error' };
    case 'aborted':
      return { outcome: 'cancelled', errorType: 'cancelled' };
  }
}

function turnEndReason(outcome: TurnOutcome): string {
  switch (outcome.type) {
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
  }
}

export function deriveAgentTelemetry(agent: Agent, telemetry: TelemetryFace): void {
  const live = agent.loop.state;
  let currentTurnId: number | undefined = live.turn?.id;
  let turnStartedAt: number | undefined;
  let atStep = live.turn?.step ?? 0;
  const tools = new Map<string, TrackedTool>(
    live.tools.map((tool) => [tool.toolCall.id, { name: tool.toolCall.name, startedAt: Date.now() }]),
  );

  const finishTool = (
    toolCallId: string,
    outcome: ToolCallOutcomeKind,
    errorType?: 'cancelled' | 'error',
  ): void => {
    const tool = tools.get(toolCallId);
    if (tool === undefined) {
      return;
    }
    tools.delete(toolCallId);
    telemetry.track('tool_call', {
      turn_id: currentTurnId,
      tool_call_id: toolCallId,
      tool_name: tool.name,
      outcome,
      duration_ms: Date.now() - tool.startedAt,
      error_type: errorType,
    });
  };

  useLoopEvent('turn.started', (event) => {
    currentTurnId = event.turnId;
    turnStartedAt = Date.now();
    atStep = 0;
    telemetry.setContext({ turn_id: event.turnId });
    telemetry.track('turn_started', { turn_id: event.turnId });
  });
  useLoopEvent('step.started', (event) => {
    atStep = event.step;
  });
  useLoopEvent('turn.ended', (event) => {
    if (event.outcome.type === 'aborted') {
      telemetry.track('turn_interrupted', {
        turn_id: currentTurnId,
        at_step: atStep,
        interrupt_reason: 'aborted',
      });
    }
    telemetry.track('turn_ended', {
      turn_id: event.turnId,
      reason: turnEndReason(event.outcome),
      duration_ms: turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt,
    });
    telemetry.setContext({ turn_id: undefined });
    currentTurnId = undefined;
    turnStartedAt = undefined;
    atStep = 0;
  });
  useLoopEvent('prompt.canceled', (event) => {
    if (!event.canceled) {
      return;
    }
    telemetry.track('turn_interrupted', {
      turn_id: currentTurnId,
      at_step: atStep,
      interrupt_reason: 'user_cancelled',
    });
    telemetry.track('cancel');
  });
  useLoopEvent('tool.started', (event) => {
    tools.set(event.toolCall.id, { name: event.toolCall.name, startedAt: Date.now() });
  });
  useLoopEvent('tool.ended', (event) => {
    const { outcome, errorType } = toolCallOutcomeOf(event.outcome);
    finishTool(event.toolCallId, outcome, errorType);
  });
  useLoopEvent('tool.async_ended', (event) => {
    const { outcome, errorType } = asyncToolOutcomeOf(event.outcome);
    finishTool(event.toolCallId, outcome, errorType);
  });
  useLoopEvent('llm.ended', (event) => {
    if (event.outcome.type !== 'failed') return;
    telemetry.track('api_error', {
      error_type: event.outcome.error.kind,
    });
  });
  useLoopEvent('llm.streaming.usage', (event) => {
    const usage = event.usage;
    const inputs = [usage.inputOther, usage.inputCacheRead, usage.inputCacheCreation];
    telemetry.track('prompt_cache_probe', {
      turn_id: currentTurnId,
      input_tokens: inputs.every((value) => value === undefined)
        ? undefined
        : inputs.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      input_cache_read: usage.inputCacheRead,
      input_cache_creation: usage.inputCacheCreation,
      output_tokens: usage.output,
    });
  });
  useLoopEvent('prompt.steered', (event) => {
    telemetry.track('input_steer', { count: event.promptIds.length });
  });
}
