/**
 * TranscriptFrame — the leaf render unit inside a step.
 *
 * The union is closed ("structure closed"): every kind is listed here. Tool
 * payloads (`input` / `output` / `display`) are open content — the server
 * copies engine data through opaquely and only the view layer interprets it.
 *
 * Frames never nest. Cross-references are by id: a tool frame may point at a
 * task entity (`taskId`), an interaction (`approvalId`), or a sibling agent
 * (`agentRefs`) whose own AgentTranscript can be subscribed separately.
 *
 * Interactions are global entities beside tasks (`model/interaction.ts`),
 * never step frames: they resolve asynchronously, possibly long after the
 * originating step flushed, so they do not live inside the paginated timeline.
 */

import type { AgentId, AttachmentId, FrameId, InteractionId, TaskId, TodoId } from './ids';

export type { InteractionKind, InteractionState } from './interaction';

export type FrameRef = {
  readonly target: 'frame';
  readonly frameId: FrameId;
};

/** Assistant / user visible text. L1 always holds the full text so far. */
export interface TextFrame {
  readonly kind: 'text';
  readonly frameId: FrameId;
  readonly role: 'assistant' | 'user';
  readonly text: string;
  /** Attachments carried by this message (entities in `attachments`). */
  readonly attachmentIds?: readonly AttachmentId[];
  /**
   * For user-role inputs that are about a task — e.g. a background-task
   * completion notification injected into the running step — the referenced
   * task entity. The text is the point-in-time record; the ref links the
   * live task.
   */
  readonly taskId?: TaskId;
}

/** Model thinking chain. Same full-text invariant as TextFrame. */
export interface ThinkingFrame {
  readonly kind: 'thinking';
  readonly frameId: FrameId;
  readonly text: string;
}

export type ToolFrameState = 'running' | 'done' | 'error';

/**
 * The latest progress update of a running tool call (`tool.progress`),
 * overwrite semantics — only the newest rides the frame.
 */
export interface ToolFrameProgress {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export interface AgentRef {
  readonly agentId: AgentId;
  /** 'member' marks one child of an agent group (swarm); default is 'child'. */
  readonly role?: 'child' | 'member';
}

export interface ToolCallFrame {
  readonly kind: 'tool';
  readonly frameId: FrameId;
  readonly toolCallId: string;
  /** Engine tool name, e.g. 'Read' / 'Bash' / 'Agent' / 'AgentSwarm'. */
  readonly name: string;
  /**
   * Optional view hint. Dispatch key at the view layer is `view ?? name`, so
   * the server can suggest a renderer (e.g. 'swarm') without a new frame kind.
   */
  readonly view?: string;
  readonly state: ToolFrameState;
  /** Open content envelopes — opaque to this layer. */
  readonly input?: unknown;
  readonly output?: unknown;
  readonly display?: unknown;
  readonly error?: string;
  /**
   * Raw argument text accumulated from `tool.call.delta`. `input` is the
   * parsed object; this is the verbatim source text, kept after
   * `tool.call.started` lands.
   */
  readonly inputText?: string;
  /** Newest `tool.progress` update. */
  readonly progress?: ToolFrameProgress;
  /** Execution entity (backgroundable shell / subagent run) behind this call. */
  readonly taskId?: TaskId;
  /** Interaction (approval/question) that gated this call, if any. */
  readonly approvalId?: InteractionId;
  /** Todo entity this call mutates (TodoList writes). */
  readonly todoId?: TodoId;
  /** Agents spawned by this call (Agent tool / AgentSwarm members). */
  readonly agentRefs?: readonly AgentRef[];
}

/** Errors / warnings / informational notices attached to a step. */
export interface NoticeFrame {
  readonly kind: 'notice';
  readonly frameId: FrameId;
  readonly level: 'error' | 'warning' | 'info';
  /** Origin subsystem, e.g. 'mcp', 'hook', 'compaction'. */
  readonly source?: string;
  readonly message: string;
  readonly detail?: unknown;
}

export type TranscriptFrame =
  | TextFrame
  | ThinkingFrame
  | ToolCallFrame
  | NoticeFrame;
