export type ResponsesInputContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; detail?: string; image_url: string }
  | { type: 'input_file'; file_data: string; filename: string }
  | { type: 'input_file'; file_url: string }
  | { type: 'output_text'; text: string; annotations: unknown[] };

export type ResponsesInputItem =
  | { type: 'message'; role: string; content: ResponsesInputContentItem[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | ResponsesInputContentItem[] }
  | {
      type: 'reasoning';
      summary: { type: 'summary_text'; text: string }[];
      encrypted_content?: string;
    };

export type OpenAIResponsesRawChunk = Record<string, unknown>;

export type OpenAIResponsesRawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
};
