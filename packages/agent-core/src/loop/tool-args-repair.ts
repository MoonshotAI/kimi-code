import { jsonrepair } from 'jsonrepair';

import { errorMessage } from './errors';

const MAX_SCHEMA_HINT_CHARS = 1200;

export type ParseToolArgsResult =
  | {
      readonly success: true;
      readonly data: unknown;
      readonly repaired: boolean;
      readonly originalError?: string;
    }
  | {
      readonly success: false;
      readonly error: string;
    };

export function parseOrRepairToolCallArguments(raw: string | null): ParseToolArgsResult {
  if (raw === null || raw.length === 0) {
    return { success: true, data: {}, repaired: false };
  }

  try {
    return { success: true, data: JSON.parse(raw) as unknown, repaired: false };
  } catch (error) {
    const originalError = errorMessage(error);

    try {
      const repairedText = jsonrepair(raw);
      const data = JSON.parse(repairedText) as unknown;
      return { success: true, data, repaired: true, originalError };
    } catch {
      return { success: false, error: originalError };
    }
  }
}

export function buildToolArgsSchemaHint(parameters: Record<string, unknown>): string {
  const propertiesValue = parameters['properties'];
  if (!isRecord(propertiesValue)) {
    return '';
  }

  const propertyEntries = Object.entries(propertiesValue);
  if (propertyEntries.length === 0) {
    return '';
  }

  const required = readRequiredNames(parameters['required']);
  const requiredNames = [...required];
  const requiredLine =
    requiredNames.length > 0 ? `- required: ${requiredNames.join(', ')}` : '- required: (none)';

  const propertiesLine = propertyEntries
    .map(([name, schema]) => {
      const optionalMarker = required.has(name) ? '' : '?';
      return `${name} (${schemaTypeLabel(schema)}${optionalMarker})`;
    })
    .join(', ');

  const hint = `Expected arguments schema:\n${requiredLine}\n- properties: ${propertiesLine}`;
  return hint.length > MAX_SCHEMA_HINT_CHARS ? `${hint.slice(0, MAX_SCHEMA_HINT_CHARS)}…` : hint;
}

function readRequiredNames(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(value.filter((item): item is string => typeof item === 'string'));
}

function schemaTypeLabel(schema: unknown): string {
  if (!isRecord(schema)) {
    return 'unknown';
  }

  const type = schema['type'];
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type)) {
    return type.filter((item): item is string => typeof item === 'string').join(' | ') || 'unknown';
  }
  if (isRecord(schema['properties'])) {
    return 'object';
  }
  if (schema['enum'] !== undefined) {
    return 'enum';
  }
  if (schema['anyOf'] !== undefined || schema['oneOf'] !== undefined || schema['allOf'] !== undefined) {
    return 'object';
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
