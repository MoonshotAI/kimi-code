import type { AgentCommands } from '#/app/agentUnit';
import { extractText } from '#/llm/message';

import type { ToolOutput } from '#/agent-machine/tool';

import type { TelemetryFace } from './feature';

interface TrackedTool {
  readonly name: string;
  readonly startedAt: number;
}

type ToolCallOutcome = 'success' | 'error' | 'cancelled';

function toolCallOutcomeOf(output: ToolOutput): {
  outcome: ToolCallOutcome;
  errorType?: 'cancelled' | 'error';
} {
  if (output.type === 'failed') return { outcome: 'error', errorType: 'error' };
  if (output.type === 'aborted') return { outcome: 'cancelled', errorType: 'cancelled' };
  if (output.result.isError !== true) return { outcome: 'success' };
  const text = extractText({ content: output.result.content }).toLowerCase();
  const outcome =
    text.includes('aborted') || text.includes('cancelled') || text.includes('manually interrupted')
      ? 'cancelled'
      : 'error';
  return { outcome, errorType: outcome === 'cancelled' ? 'cancelled' : 'error' };
}

export function deriveAgentTelemetry(agent: AgentCommands, telemetry: TelemetryFace): void {
  let currentTurnId: number | undefined;
  let turnStartedAt: number | undefined;
  let atStep = 0;
  const tools = new Map<string, TrackedTool>();

  const finishTool = (
    toolCallId: string,
    outcome: ToolCallOutcome,
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

  agent.on('turn.started', (event) => {
    currentTurnId = event.turnId;
    turnStartedAt = Date.now();
    atStep = 0;
    telemetry.setContext({ turn_id: event.turnId, model: agent.model?.spec.name });
    telemetry.track('turn_started', { turn_id: event.turnId });
  });
  agent.on('step.started', (event) => {
    atStep = event.step;
  });
  agent.on('turn.done', (event) => {
    const reason =
      event.outcome.type === 'done'
        ? 'completed'
        : event.outcome.type === 'failed'
          ? 'failed'
          : 'cancelled';
    telemetry.track('turn_ended', {
      turn_id: event.turnId,
      reason,
      duration_ms: turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt,
    });
    telemetry.setContext({ turn_id: undefined });
    currentTurnId = undefined;
    turnStartedAt = undefined;
    atStep = 0;
  });
  agent.on('prompt.cancelled', (event) => {
    if (!event.cancelled) {
      return;
    }
    telemetry.track('turn_interrupted', {
      turn_id: currentTurnId,
      at_step: atStep,
      interrupt_reason: 'user_cancelled',
    });
    telemetry.track('cancel');
  });
  agent.on('agent.aborted', () => {
    telemetry.track('turn_interrupted', {
      turn_id: currentTurnId,
      at_step: atStep,
      interrupt_reason: 'aborted',
    });
  });
  agent.on('turn.spawn_tools', (event) => {
    for (const toolCall of event.toolCalls) {
      tools.set(toolCall.id, { name: toolCall.name, startedAt: Date.now() });
    }
  });
  agent.on('tool.done', (event) => {
    const { outcome, errorType } = toolCallOutcomeOf(event.outcome);
    finishTool(event.toolCallId, outcome, errorType);
  });
  agent.on('llm.ended', (event) => {
    if (event.outcome.type !== 'failed') return;
    telemetry.track('api_error', {
      error_type: event.outcome.error.kind,
      model: agent.model?.spec.name,
    });
  });
  agent.on('llm.streaming.usage', (event) => {
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
  agent.on('prompt.steered', (event) => {
    telemetry.track('input_steer', { count: event.ids.length });
  });
}
