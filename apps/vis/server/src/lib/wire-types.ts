/**
 * Local wire-type copies formerly imported from `@moonshot-ai/kosong`.
 *
 * These mirror kosong's `message.ts` / `provider.ts` / `usage.ts` shapes so
 * `apps/vis/server` can operate without depending on the LLM abstraction
 * package (G-5: kosong's core is superseded by the Rust engine's native LLM
 * transport; only data-shape consumers remain, and they localize). The
 * shapes are frozen by the session wire protocol, so a local copy stays in
 * sync by definition.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string; // Provider-specific reasoning signature
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string | undefined };
}

/** A single piece of content within a `Message`. */
export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

export interface ToolCall {
  type: 'function';
  id: string;
  name: string;
  arguments: string | null;
  extras?: Record<string, unknown>;
}

export interface Message {
  readonly role: Role;
  readonly name?: string;
  readonly content: ContentPart[];
  readonly toolCalls: ToolCall[];
  readonly toolCallId?: string;
  readonly partial?: boolean;
}

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  costUsd?: number;
}

/**
 * Tool-input display payload (protocol `ToolInputDisplay` parity, localized).
 * The 12-arm discriminated union mirrors `packages/protocol/src/display.ts`;
 * the shapes are frozen by the session wire protocol, so a local copy stays
 * in sync by definition.
 */
export type ToolInputDisplay =
  | {
      kind: 'command';
      command: string;
      cwd?: string;
      description?: string;
      language?: 'bash';
    }
  | {
      kind: 'file_io';
      operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      path: string;
      detail?: string;
      content?: string;
      before?: string;
      after?: string;
    }
  | {
      kind: 'diff';
      path: string;
      before: string;
      after: string;
      hunks?: number;
    }
  | { kind: 'search'; query: string; scope?: string }
  | { kind: 'url_fetch'; url: string; method?: string }
  | { kind: 'agent_call'; agent_name: string; prompt: string; background?: boolean }
  | { kind: 'skill_call'; skill_name: string; args?: string }
  | { kind: 'todo_list'; items: Array<{ title: string; status: string }> }
  | {
      kind: 'task';
      task_id: string;
      status: string;
      description: string;
      task_kind?: string;
    }
  | { kind: 'task_stop'; task_id: string; task_description: string }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string;
      options?: ReadonlyArray<{ label: string; description: string }>;
    }
  | {
      kind: 'goal_start';
      objective: string;
      completionCriterion?: string;
      mode: 'manual' | 'yolo';
    }
  | { kind: 'generic'; summary: string; detail?: unknown };
