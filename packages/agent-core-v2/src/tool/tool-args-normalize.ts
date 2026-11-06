export interface ToolSchemaTarget {
  readonly name?: string;
  readonly parameters?: Record<string, unknown>;
}

function hasProperty(properties: Record<string, unknown> | undefined, key: string): boolean {
  return properties !== undefined && Object.prototype.hasOwnProperty.call(properties, key);
}

function toInteger(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  return value;
}

function toLineOffset(value: unknown): unknown {
  const integer = toInteger(value);
  if (typeof integer === 'number') {
    return integer === 0 ? 1 : integer;
  }
  return value;
}

export function normalizeToolArgs(
  tool: ToolSchemaTarget | undefined,
  args: unknown,
): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }

  const normalized: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  const rawProperties =
    tool?.parameters &&
    typeof tool.parameters === 'object' &&
    'properties' in tool.parameters &&
    tool.parameters['properties'] &&
    typeof tool.parameters['properties'] === 'object'
      ? (tool.parameters['properties'] as Record<string, unknown>)
      : undefined;

  const toolName = tool?.name?.toLowerCase();
  const isBuiltinTool =
    toolName === 'read' ||
    toolName === 'write' ||
    toolName === 'edit';

  const isStrictlyClosedSchema =
    isBuiltinTool ||
    (tool?.parameters !== undefined &&
      typeof tool.parameters === 'object' &&
      tool.parameters['additionalProperties'] === false);

  function schemaRejects(key: string): boolean {
    return isStrictlyClosedSchema && !hasProperty(rawProperties, key);
  }

  const supportsLineOffset =
    hasProperty(rawProperties, 'line_offset') || toolName === 'read';
  const supportsNLines =
    hasProperty(rawProperties, 'n_lines') || toolName === 'read';
  const supportsPath =
    hasProperty(rawProperties, 'path') ||
    toolName === 'read' ||
    toolName === 'write' ||
    toolName === 'edit';

  if (supportsLineOffset) {
    if (schemaRejects('offset') && 'offset' in normalized) {
      if (normalized['line_offset'] === undefined) {
        normalized['line_offset'] = toLineOffset(normalized['offset']);
      }
      delete normalized['offset'];
    }
    if (schemaRejects('start_line') && 'start_line' in normalized) {
      if (normalized['line_offset'] === undefined) {
        normalized['line_offset'] = toLineOffset(normalized['start_line']);
      }
      delete normalized['start_line'];
    }
    if (schemaRejects('parameter_offset') && 'parameter_offset' in normalized) {
      if (normalized['line_offset'] === undefined) {
        normalized['line_offset'] = toLineOffset(normalized['parameter_offset']);
      }
      delete normalized['parameter_offset'];
    }
  }

  if (supportsNLines) {
    if (schemaRejects('limit') && 'limit' in normalized) {
      if (normalized['n_lines'] === undefined) {
        normalized['n_lines'] = toInteger(normalized['limit']);
      }
      delete normalized['limit'];
    }
  }

  if (supportsPath) {
    if (schemaRejects('file_path') && 'file_path' in normalized) {
      if (normalized['path'] === undefined) {
        normalized['path'] = normalized['file_path'];
      }
      delete normalized['file_path'];
    }
    if (schemaRejects('filepath') && 'filepath' in normalized) {
      if (normalized['path'] === undefined) {
        normalized['path'] = normalized['filepath'];
      }
      delete normalized['filepath'];
    }
  }

  if (schemaRejects('description_note') && 'description_note' in normalized) {
    delete normalized['description_note'];
  }
  if (schemaRejects('details') && 'details' in normalized) {
    delete normalized['details'];
  }

  return normalized;
}
