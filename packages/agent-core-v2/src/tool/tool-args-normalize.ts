export interface ToolSchemaTarget {
  readonly name?: string;
  readonly parameters?: Record<string, unknown>;
}

function hasProperty(properties: Record<string, unknown> | undefined, key: string): boolean {
  return properties !== undefined && Object.prototype.hasOwnProperty.call(properties, key);
}

function toInteger(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
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
    if (normalized['line_offset'] === undefined) {
      if ('offset' in normalized) {
        normalized['line_offset'] = toLineOffset(normalized['offset']);
      } else if ('start_line' in normalized) {
        normalized['line_offset'] = toLineOffset(normalized['start_line']);
      } else if ('parameter_offset' in normalized) {
        normalized['line_offset'] = toLineOffset(normalized['parameter_offset']);
      }
    }
    delete normalized['offset'];
    delete normalized['start_line'];
    delete normalized['parameter_offset'];
  }

  if (supportsNLines) {
    if (normalized['n_lines'] === undefined && 'limit' in normalized) {
      normalized['n_lines'] = toInteger(normalized['limit']);
    }
    delete normalized['limit'];
  }

  if (supportsPath) {
    if (!hasProperty(rawProperties, 'file_path') && 'file_path' in normalized) {
      if (normalized['path'] === undefined) {
        normalized['path'] = normalized['file_path'];
      }
      delete normalized['file_path'];
    }
    if (!hasProperty(rawProperties, 'filepath') && 'filepath' in normalized) {
      if (normalized['path'] === undefined) {
        normalized['path'] = normalized['filepath'];
      }
      delete normalized['filepath'];
    }
  }

  if (rawProperties !== undefined) {
    if (!hasProperty(rawProperties, 'description_note') && 'description_note' in normalized) {
      delete normalized['description_note'];
    }
    if (!hasProperty(rawProperties, 'details') && 'details' in normalized) {
      delete normalized['details'];
    }
  }

  return normalized;
}
