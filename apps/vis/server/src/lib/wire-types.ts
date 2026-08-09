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
