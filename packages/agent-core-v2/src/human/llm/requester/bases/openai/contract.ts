export type OpenAIContentPart = {
  type: 'text' | 'image_url' | 'audio_url' | 'video_url';
  text?: string | undefined;
  image_url?: { url: string; id?: string | null } | undefined;
  audio_url?: { url: string; id?: string | null } | undefined;
  video_url?: { url: string; id?: string | null } | undefined;
};

export type OpenAIWireToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type OpenAIWireMessage =
  | { role: 'system' | 'user'; content: string | OpenAIContentPart[] }
  | {
      role: 'assistant';
      content: string | OpenAIContentPart[] | null;
      tool_calls?: OpenAIWireToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string | OpenAIContentPart[] };

export type OpenAIRawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

export type OpenAIRawStreamToolCallDelta = {
  index?: number | string;
  id?: string;
  function?: { name?: string; arguments?: string } | null;
};

export type OpenAIRawChunk = {
  id?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAIRawStreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIRawUsage | null;
};
