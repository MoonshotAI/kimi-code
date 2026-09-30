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
