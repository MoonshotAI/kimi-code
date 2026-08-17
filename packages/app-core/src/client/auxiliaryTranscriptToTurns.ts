import type {
  AgentTranscriptSnapshot,
  TranscriptAttachment,
  TranscriptTask,
  TranscriptTurn,
} from '../transcript';
import type { AppMessage, AppMessageContent, ImageSource } from '../api';

import { messagesToTurns, normalizeToolOutput } from './messagesToTurns';
import { TASK_NOTIFICATION_METADATA_KEY } from './notificationXml';
import type { ChatTurn, TaskNotification } from './types';

export function auxiliaryTranscriptToTurns(
  snapshot: AgentTranscriptSnapshot,
  getFileUrl?: (fileId: string) => string,
  agent?: { createdAt?: string; disposedAt?: string },
  options?: {
    /** The session the transcript belongs to — synthesized messages otherwise
     *  carry no session id, and session-media attachments need it to fetch
     *  bytes from the session-scoped media route. */
    sessionId?: string;
    getSessionMediaUrl?: (sessionId: string, fileId: string) => string;
  },
): ChatTurn[] {
  const transcriptTurns = snapshot.items.filter((item) => item.kind === 'turn');
  const firstTurnId = transcriptTurns[0]?.turnId;
  const onlyTurnId = transcriptTurns.length === 1 ? firstTurnId : undefined;
  const taskById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
  const messages = snapshot.items.flatMap((item) =>
    item.kind === 'turn'
      ? turnToMessages(
          item,
          snapshot.attachments,
          taskById,
          item.turnId === firstTurnId ? agent?.createdAt : undefined,
          item.turnId === onlyTurnId ? agent?.disposedAt : undefined,
          options?.sessionId,
        )
      : [],
  );
  const running = snapshot.meta.activity === 'turn';
  return messagesToTurns(messages, [], getFileUrl, running, {}, {}, { getSessionMediaUrl: options?.getSessionMediaUrl }).map(clearMissingTimestamps);
}

function turnToMessages(
  turn: TranscriptTurn,
  attachments: readonly TranscriptAttachment[],
  taskById: ReadonlyMap<string, TranscriptTask>,
  fallbackStartedAt?: string,
  fallbackEndedAt?: string,
  sessionId = '',
): AppMessage[] {
  const messages: AppMessage[] = [];
  const attachmentById = new Map(attachments.map((item) => [item.attachmentId, item]));
  const createdAt = earliestTimestamp([
    turn.startedAt,
    ...turn.steps.map((step) => step.startedAt),
    fallbackStartedAt,
  ]) ?? '';
  const endedAt = validTimestamp(turn.endedAt) ?? validTimestamp(fallbackEndedAt);
  const promptId = turn.turnId;

  if (turn.prompt !== undefined && turn.prompt.length > 0) {
    const content: AppMessageContent[] = [{ type: 'text', text: turn.prompt }];
    for (const attachmentId of turn.attachmentIds ?? []) {
      const attachment = attachmentToContent(attachmentById.get(attachmentId));
      if (attachment !== undefined) content.push(attachment);
    }
    messages.push({
      id: `${turn.turnId}:input`,
      sessionId,
      role: 'user',
      content,
      createdAt,
      promptId,
      metadata:
        turn.origin.kind === 'task' && turn.prompt.includes('<notification')
          ? { origin: turn.origin.payload ?? turn.origin }
          : undefined,
    });
  }

  for (const step of turn.steps) {
    for (const frame of step.frames) {
      if (frame.kind === 'text') {
        if (frame.text.length === 0) continue;
        if (frame.role === 'user') {
          if (frame.taskId === undefined) continue;
          const notification = taskFrameNotification(
            frame.taskId,
            frame.text,
            taskById.get(frame.taskId),
          );
          messages.push({
            id: frame.frameId,
            sessionId: '',
            role: 'user',
            content: [{ type: 'text', text: frame.text }],
            createdAt: step.startedAt ?? createdAt,
            promptId,
            metadata: {
              origin: { kind: 'task', taskId: frame.taskId },
              [TASK_NOTIFICATION_METADATA_KEY]: notification,
            },
          });
          continue;
        }
        messages.push({
          id: frame.frameId,
          sessionId: '',
          role: 'assistant',
          content: [{ type: 'text', text: frame.text }],
          createdAt: step.startedAt ?? createdAt,
          promptId,
        });
      } else if (frame.kind === 'thinking') {
        if (frame.text.length === 0) continue;
        messages.push({
          id: frame.frameId,
          sessionId: '',
          role: 'assistant',
          content: [{
            type: 'thinking',
            thinking: frame.text,
            startedAt: step.startedAt,
            durationMs: durationMs(step.startedAt, step.endedAt),
          }],
          createdAt: step.startedAt ?? createdAt,
          promptId,
        });
      } else if (frame.kind === 'tool') {
        messages.push({
          id: `${frame.frameId}:call`,
          sessionId: '',
          role: 'assistant',
          content: [{
            type: 'toolUse',
            toolCallId: frame.toolCallId,
            toolName: frame.name,
            input: frame.input ?? frame.display ?? {},
            outputLines:
              frame.state === 'running' ? normalizeToolOutput(frame.output) : undefined,
            agentRefs: frame.agentRefs,
          }],
          createdAt: step.startedAt ?? createdAt,
          promptId,
        });
        if (frame.state !== 'running') {
          messages.push({
            id: `${frame.frameId}:result`,
            sessionId: '',
            role: 'tool',
            content: [{
              type: 'toolResult',
              toolCallId: frame.toolCallId,
              output: frame.output ?? frame.error ?? '',
              isError: frame.state === 'error',
            }],
            createdAt: step.endedAt ?? step.startedAt ?? createdAt,
            promptId,
          });
        }
      }
    }
  }

  const duration = turn.durationMs ?? durationMs(createdAt || undefined, endedAt);
  if (duration !== undefined) {
    const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
    if (lastAssistant >= 0) {
      messages[lastAssistant] = { ...messages[lastAssistant]!, durationMs: duration };
    }
  }
  return messages;
}

function taskFrameNotification(
  taskId: string,
  text: string,
  task: TranscriptTask | undefined,
): TaskNotification {
  const [title = '', ...body] = text.split('\n');
  const state = task?.state ?? 'info';
  return {
    id: `task:${taskId}:${state}`,
    category: 'task',
    type: `task.${state}`,
    sourceKind: task?.kind === 'subagent' ? 'subagent' : 'background_task',
    sourceId: taskId,
    agentId: task?.agentId,
    title: title.trim(),
    severity: state === 'completed' ? 'info' : 'warning',
    body: body.join('\n').trim(),
    raw: text,
  };
}

function clearMissingTimestamps(turn: ChatTurn): ChatTurn {
  if (turn.createdAt !== '' && turn.endedAt !== '') return turn;
  const next = { ...turn };
  if (next.createdAt === '') delete next.createdAt;
  if (next.endedAt === '') delete next.endedAt;
  return next;
}

function earliestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  let earliest: { value: string; time: number } | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (earliest === undefined || time < earliest.time) earliest = { value, time };
  }
  return earliest?.value;
}

function validTimestamp(value: string | undefined): string | undefined {
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function attachmentToContent(
  attachment: TranscriptAttachment | undefined,
): AppMessageContent | undefined {
  if (attachment?.source === undefined) return undefined;
  // A daemon media reference addresses the session's own media store, not the
  // global upload store — keep the source kinds distinct so the byte fetch
  // goes through the session-scoped media route.
  const source: ImageSource =
    attachment.source.kind === 'url'
      ? { kind: 'url', url: attachment.source.url }
      : attachment.source.kind === 'session_media'
        ? { kind: 'sessionMedia', fileId: attachment.source.fileId }
        : { kind: 'file', fileId: attachment.source.fileId };
  if (attachment.mediaType.startsWith('image/')) {
    return { type: 'image', source };
  }
  if (attachment.mediaType.startsWith('video/')) {
    return { type: 'video', source };
  }
  if (attachment.source.kind !== 'file') return undefined;
  return {
    type: 'file',
    fileId: attachment.source.fileId,
    name: attachment.name ?? attachment.attachmentId,
    mediaType: attachment.mediaType,
    size: attachment.size ?? 0,
  };
}

function durationMs(startedAt?: string, endedAt?: string): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
