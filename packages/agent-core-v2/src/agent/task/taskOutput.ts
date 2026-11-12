import { join } from 'pathe';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { escapeXml, escapeXmlAttr, escapeXmlTags } from '#/_base/utils/xml-escape';
import { userCancellationReason } from '#/_base/utils/abort';
import { createUserMessage, type UserMessage } from '@moonshot-ai/core/llm/message';
import type { TaskOrigin } from '#/agent/contextMemory/types';
import { environmentTempTarget, IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AgentTaskPersistence } from './persist';
import { renderNotificationXml } from './notificationXml';
import { formatTaskWallTime } from './wallTime';
import type { AgentTaskInfo } from './types';
import type { AgentTaskOutputSnapshot, AgentTaskOutputTail } from './task';
import type { ToolOutput, ToolOutputStore } from '#/tool/executor/types';

const QUESTION_ANSWER_INLINE_BYTES = 16_000;

export interface AgentTaskNotification extends Record<string, unknown> {
  readonly id: string;
  readonly category: 'task';
  readonly type: string;
  readonly source_kind: 'background_task';
  readonly source_id: string;
  readonly agent_id?: string | undefined;
  readonly title: string;
  readonly severity: 'info' | 'warning';
  readonly body: string;
  readonly children?: readonly string[] | undefined;
}

export interface IAgentTaskOutputService extends ToolOutputStore {
  readonly _serviceBrand: undefined;
  appendTaskOutput(taskId: string, chunk: string): Promise<void>;
  readTaskOutputSnapshot(taskId: string, maxPreviewBytes: number): ReturnType<AgentTaskPersistence['readTaskOutputSnapshot']>;
  readTaskOutputTail(taskId: string, maxBytes: number): Promise<AgentTaskOutputTail | undefined>;
  createCompletion(
    info: AgentTaskInfo,
    toolCallId: string,
    output?: AgentTaskOutputSnapshot,
  ): Promise<UserMessage>;
}

export const IAgentTaskOutputService = createDecorator<IAgentTaskOutputService>('agentTaskOutputService');

export class AgentTaskOutputService implements IAgentTaskOutputService {
  declare readonly _serviceBrand: undefined;
  private readonly persistence: AgentTaskPersistence;

  constructor(
    @IFileSystemStorageService byteStore: IFileSystemStorageService,
    @ISessionContext session: ISessionContext,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentEnvironmentService environment: IAgentEnvironmentService | undefined,
    @ILogService private readonly log: ILogService,
  ) {
    const fallbackRoot = scopeContext.agentId === 'main'
      ? { dir: session.sessionDir, scope: session.scope() }
      : undefined;
    this.persistence = new AgentTaskPersistence(
      join(session.sessionDir, 'agents', scopeContext.agentId),
      scopeContext.scope(),
      byteStore,
      fallbackRoot,
      () => environment === undefined ? undefined : environmentTempTarget(environment, 'task-output'),
    );
  }

  open(taskId: string): ToolOutput {
    return this.persistence.open(taskId);
  }

  appendTaskOutput(taskId: string, chunk: string): Promise<void> {
    return this.persistence.appendTaskOutput(taskId, chunk);
  }

  readTaskOutputSnapshot(taskId: string, maxPreviewBytes: number): ReturnType<AgentTaskPersistence['readTaskOutputSnapshot']> {
    return this.persistence.readTaskOutputSnapshot(taskId, maxPreviewBytes);
  }

  readTaskOutputTail(taskId: string, maxBytes: number): Promise<AgentTaskOutputTail | undefined> {
    return this.persistence.readTaskOutputTail(taskId, maxBytes);
  }

  async createCompletion(
    info: AgentTaskInfo,
    toolCallId: string,
    output?: AgentTaskOutputSnapshot,
  ): Promise<UserMessage> {
    let snapshot = output;
    if (snapshot === undefined) {
      try {
        snapshot = await this.notificationOutputSnapshot(info);
      } catch (error) {
        this.log.error('task notification output read failed; delivering without output', {
          taskId: info.taskId,
          error,
        });
        snapshot = emptyOutputSnapshot();
      }
    }
    return createTaskCompletionEntry(info, toolCallId, snapshot);
  }

  private async notificationOutputSnapshot(info: AgentTaskInfo): Promise<AgentTaskOutputSnapshot> {
    if (info.kind === 'question') {
      const output = await this.readTaskOutputSnapshot(info.taskId, QUESTION_ANSWER_INLINE_BYTES);
      return output === undefined ? emptyOutputSnapshot() : { ...output, fullOutputAvailable: true };
    }
    const persisted = await this.readTaskOutputSnapshot(info.taskId, 0);
    if (persisted !== undefined) return { ...persisted, fullOutputAvailable: true };
    return emptyOutputSnapshot();
  }
}

export function createTaskCompletionEntry(
  info: AgentTaskInfo,
  toolCallId: string,
  output: AgentTaskOutputSnapshot,
): UserMessage {
  const notification = buildAgentTaskNotification(info, output);
  const origin: TaskOrigin = {
    kind: 'task',
    taskId: info.taskId,
    status: info.status,
    notificationId: taskNotificationId(info.taskId, info.status),
  };
  return createUserMessage(renderNotificationXml(notification), {
    source: 'async-tool',
    promptId: notification.id,
    toolCallId,
    origin,
  });
}

export function emptyOutputSnapshot(): AgentTaskOutputSnapshot {
  return {
    outputSizeBytes: 0,
    previewBytes: 0,
    truncated: false,
    fullOutputAvailable: false,
    preview: '',
  };
}

export function taskNotificationId(taskId: string, status: string): string {
  return `task:${taskId}:${status}`;
}

export function buildAgentTaskNotification(
  info: AgentTaskInfo,
  output?: AgentTaskOutputSnapshot,
): AgentTaskNotification {
  const question = questionNotificationText(info, output);
  return {
    id: taskNotificationId(info.taskId, info.status),
    category: 'task',
    type: `task.${info.status}`,
    source_kind: 'background_task',
    source_id: info.taskId,
    agent_id: info.kind === 'agent' ? info.agentId : undefined,
    title: question?.title ?? `Background ${info.kind} ${info.status}`,
    severity: info.status === 'completed' ? 'info' : 'warning',
    body: question?.body ?? buildAgentTaskNotificationBody(info),
    children: agentTaskNotificationChildren(info, output),
  };
}

function buildAgentTaskNotificationBody(info: AgentTaskInfo): string {
  const baseLine = info.status === 'timed_out'
    ? `${info.description} timed out.`
    : info.status === 'killed' && isSerializedUserCancellation(info.stopReason)
      ? `${info.description} was stopped by user.`
      : info.stopReason
        ? `${info.description} ${info.status === 'killed' ? 'was stopped' : info.status}. Reason: ${info.stopReason}`
        : `${info.description} ${info.status}.`;
  const timed = `Wall time: ${formatTaskWallTime(info)}\n${baseLine}`;
  if (info.kind !== 'agent' || info.status === 'completed') return timed;
  const agentId = info.agentId;
  if (agentId === undefined || agentId === info.taskId) return timed;
  const recovery = [
    '',
    `To recover or continue this subagent, call Agent(resume="${agentId}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    `Use agent_id ("${agentId}"), NOT source_id / task_id ("${info.taskId}") — the two look alike but only agent_id is accepted by the resume parameter.`,
    'Add run_in_background=true to keep it backgrounded, or omit it to take the result inline in the current turn.',
    'The subagent retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');
  return `${timed}${recovery}`;
}

function agentTaskNotificationChildren(
  info: AgentTaskInfo,
  output: AgentTaskOutputSnapshot | undefined,
): readonly string[] | undefined {
  if (output === undefined) return undefined;
  if (inlinesQuestionAnswer(info, output)) {
    return output.preview.length === 0 ? undefined : [renderAnswerBlock(output.preview)];
  }
  if (output.fullOutputAvailable && output.outputPath !== undefined) {
    return [renderOutputFileBlock(output.outputPath, output.outputSizeBytes)];
  }
  if (output.preview.length === 0) return undefined;
  return [renderOutputPreviewBlock(output)];
}

function inlinesQuestionAnswer(info: AgentTaskInfo, output: AgentTaskOutputSnapshot): boolean {
  return info.kind === 'question' && !output.truncated;
}

function renderAnswerBlock(answer: string): string {
  return ['<answer>', escapeXmlTags(answer), '</answer>'].join('\n');
}

function questionNotificationText(
  info: AgentTaskInfo,
  output: AgentTaskOutputSnapshot | undefined,
): { readonly title: string; readonly body: string } | undefined {
  if (info.status !== 'completed' || output === undefined || !inlinesQuestionAnswer(info, output)) return undefined;
  const outcome = questionOutcome(output.preview);
  if (outcome === 'answered') {
    return { title: 'Background question answered', body: `The user answered "${info.description}".` };
  }
  if (outcome === 'dismissed') {
    return { title: 'Background question dismissed', body: `The user dismissed "${info.description}" without answering.` };
  }
  return undefined;
}

function questionOutcome(output: string): 'answered' | 'dismissed' | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const answers = (parsed as { readonly answers?: unknown }).answers;
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return undefined;
  return Object.keys(answers).length > 0 ? 'answered' : 'dismissed';
}

function renderOutputFileBlock(outputPath: string, outputSizeBytes: number): string {
  return [
    `<output-file path="${escapeXmlAttr(outputPath)}" bytes="${String(outputSizeBytes)}">`,
    `Read the output file to retrieve the result: ${escapeXml(outputPath)}`,
    '</output-file>',
  ].join('\n');
}

function renderOutputPreviewBlock(output: AgentTaskOutputSnapshot): string {
  return [
    `<output-preview bytes="${String(output.previewBytes)}" total_bytes="${String(output.outputSizeBytes)}" truncated="${String(output.truncated)}">`,
    output.truncated
      ? `Showing the last ${String(output.previewBytes)} bytes. No persisted full output is available.`
      : 'No persisted full output is available; this preview is the currently buffered task output.',
    escapeXml(output.preview),
    '</output-preview>',
  ].join('\n');
}

function isSerializedUserCancellation(reason: string | undefined): boolean {
  return reason === userCancellationReason().message;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTaskOutputService,
  AgentTaskOutputService,
  ScopeActivation.OnScopeCreated,
  'taskOutput',
);
