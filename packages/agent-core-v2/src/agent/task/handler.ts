import type { LegacyToolFields, ToolExecutionHandler } from '#/tool/executor';
import type { AgentTaskInfo, AgentTaskStatus } from './types';

interface AgentTaskFieldsBase {
  readonly description: string;
  readonly timeoutMs?: number;
  readonly timedOut?: boolean;
  readonly stopReason?: string;
}

export type AgentTaskFields = AgentTaskFieldsBase &
  (
    | {
        readonly kind: 'process';
        readonly command: string;
        readonly pid: number;
        readonly exitCode: number | null;
        readonly stopCode?: string;
        readonly parentToolCallId?: string;
      }
    | {
        readonly kind: 'agent';
        readonly agentId?: string;
        readonly subagentType?: string;
        readonly parentToolCallId?: string;
        readonly model?: string;
        readonly thinkingEffort?: string;
        readonly stopCode?: string;
        readonly swarmIndex?: number;
        readonly stateReason?: string;
        readonly resultSummary?: string;
      }
    | {
        readonly kind: 'question';
        readonly questionCount: number;
        readonly toolCallId?: string;
      }
  );

export function agentTaskInfo(
  handler: ToolExecutionHandler<LegacyToolFields & { readonly task?: AgentTaskFields }, any>,
): AgentTaskInfo {
  const snapshot = handler.snapshot();
  const fields = snapshot.fields.task;
  if (fields === undefined) throw new TypeError(`Tool handler ${snapshot.taskId} has no task fields`);
  const timing = snapshot.timing.execute ?? snapshot.timing.total;
  const base = {
    taskId: snapshot.taskId,
    description: fields.description,
    status: agentTaskStatus(snapshot.status, fields.timedOut === true),
    detached: snapshot.detached,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    stopReason: fields.stopReason ?? snapshot.stopReason,
    timeoutMs: fields.timeoutMs,
  };
  switch (fields.kind) {
    case 'process':
      return {
        ...base,
        kind: 'process',
        command: fields.command,
        pid: fields.pid,
        exitCode: fields.exitCode,
        stopCode: fields.stopCode,
        parentToolCallId: fields.parentToolCallId,
      };
    case 'agent':
      return {
        ...base,
        kind: 'agent',
        agentId: fields.agentId,
        subagentType: fields.subagentType,
        parentToolCallId: fields.parentToolCallId,
        model: fields.model,
        thinkingEffort: fields.thinkingEffort,
        stopCode: fields.stopCode,
        swarmIndex: fields.swarmIndex,
        stateReason: fields.stateReason,
        resultSummary: fields.resultSummary,
      };
    case 'question':
      return {
        ...base,
        kind: 'question',
        questionCount: fields.questionCount,
        toolCallId: fields.toolCallId ?? snapshot.id,
      };
  }
}

function agentTaskStatus(
  status: 'running' | 'stopping' | 'success' | 'failed' | 'aborted',
  timedOut: boolean,
): AgentTaskStatus {
  if (timedOut && status !== 'running' && status !== 'stopping') return 'timed_out';
  switch (status) {
    case 'running':
    case 'stopping':
      return 'running';
    case 'success':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'killed';
  }
}
