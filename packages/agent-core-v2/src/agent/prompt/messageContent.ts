export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  tool_call_id: string;
  tool_name: string;
  input: unknown;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_call_id: string;
  output: unknown;
  is_error?: boolean;
}

export type ImageSource =
  | {
      kind: 'url';
      url: string;
      id?: string;
    }
  | {
      kind: 'base64';
      media_type: string;
      data: string;
    }
  | { kind: 'file'; file_id: string }
  | { kind: 'session_media'; file_id: string }
  | { kind: 'path'; path: string };

export interface ImageContent {
  type: 'image';
  source: ImageSource;
  name?: string;
}

export interface VideoContent {
  type: 'video';
  source: ImageSource;
  name?: string;
}

export interface FileContent {
  type: 'file';
  file_id?: string;
  path?: string;
  name?: string;
  media_type?: string;
  size?: number;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type MessageContent =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | ImageContent
  | VideoContent
  | FileContent
  | ThinkingContent;
