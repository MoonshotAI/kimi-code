export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

export type AnthropicWireContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | {
      type: 'image';
      source: { type: 'base64'; data: string; media_type: string } | { type: 'url'; url: string };
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'video';
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      cache_control?: { type: 'ephemeral' };
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: AnthropicWireContentBlock[];
      cache_control?: { type: 'ephemeral' };
    };

export type AnthropicWireMessage = {
  role: 'user' | 'assistant';
  content: AnthropicWireContentBlock[];
};

export type AnthropicRawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type AnthropicRawContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

export type AnthropicRawStreamEvent = {
  type: string;
  index?: number;
  content_block?: AnthropicRawContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  message?: { id?: string; usage?: AnthropicRawUsage };
  usage?: AnthropicRawUsage;
};
