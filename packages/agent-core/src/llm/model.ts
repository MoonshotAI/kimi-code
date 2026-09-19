export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly dynamically_loaded_tools?: boolean;
}

const UNKNOWN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY');

export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze(
  Object.defineProperty(
    {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: false,
      dynamically_loaded_tools: false,
    },
    UNKNOWN_CAPABILITY_MARKER,
    { value: true },
  ),
);

export function isUnknownCapability(capability: ModelCapability): boolean {
  if (capability === UNKNOWN_CAPABILITY) return true;
  return (capability as unknown as Record<PropertyKey, unknown>)[UNKNOWN_CAPABILITY_MARKER] === true;
}

export type JsonSchemaObject = Record<string, unknown>;

export interface JsonObjectResponseFormat {
  readonly type: 'json_object';
}

export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly jsonSchema: {
    readonly name: string;
    readonly schema: JsonSchemaObject;
    readonly strict?: boolean;
    readonly description?: string;
  };
}

export type ResponseFormat = JsonObjectResponseFormat | JsonSchemaResponseFormat;

export interface LlmConnection {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly betaApi?: boolean;
  readonly vertexai?: boolean;
}

export interface LlmModel extends LlmConnection {
  readonly provider: string;
  readonly model: string;
  readonly capability: ModelCapability;
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
}

export function modelKey(model: LlmModel): string {
  return model.baseUrl === undefined ? model.model : `${model.baseUrl}#${model.model}`;
}
