import type { AgentId, AttachmentId, FrameId, InteractionId, TaskId, TodoId } from './ids';

export type { InteractionKind, InteractionState } from './interaction';

export type FrameRef = {
  readonly target: 'frame';
  readonly frameId: FrameId;
};

export interface TextFrame {
  readonly kind: 'text';
  readonly frameId: FrameId;
  readonly role: 'assistant' | 'user';
  readonly text: string;
  readonly attachmentIds?: readonly AttachmentId[];
  readonly taskId?: TaskId;
  readonly promptIds?: readonly string[];
}

export interface ThinkingFrame {
  readonly kind: 'thinking';
  readonly frameId: FrameId;
  readonly text: string;
}

export type ToolFrameState = 'running' | 'done' | 'error';

export interface ToolFrameProgress {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export interface AgentRef {
  readonly agentId: AgentId;
  readonly role?: 'child' | 'member';
}

export interface ToolCallFrame {
  readonly kind: 'tool';
  readonly frameId: FrameId;
  readonly toolCallId: string;
  readonly name: string;
  readonly view?: string;
  readonly state: ToolFrameState;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly display?: unknown;
  readonly error?: string;
  readonly inputText?: string;
  readonly progress?: ToolFrameProgress;
  readonly taskId?: TaskId;
  readonly approvalId?: InteractionId;
  readonly todoId?: TodoId;
  readonly agentRefs?: readonly AgentRef[];
}

export interface NoticeFrame {
  readonly kind: 'notice';
  readonly frameId: FrameId;
  readonly level: 'error' | 'warning' | 'info';
  readonly source?: string;
  readonly message: string;
  readonly detail?: unknown;
}

export type TranscriptFrame =
  | TextFrame
  | ThinkingFrame
  | ToolCallFrame
  | NoticeFrame;
