import { isRecord } from './utils';

const DIRECT_ERROR_KEYS = ['error_description', 'message', 'detail'] as const;
const NESTED_ERROR_KEYS = ['message', 'error_description', 'detail', 'code', 'type'] as const;

export function extractApiErrorMessage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractApiErrorMessage(item);
      if (message !== undefined) return message;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const key of DIRECT_ERROR_KEYS) {
    const message = stringField(value, key);
    if (message !== undefined) return message;
  }

  const error = value['error'];
  const errorString = nonEmptyString(error);
  if (errorString !== undefined) return errorString;

  if (isRecord(error)) {
    for (const key of NESTED_ERROR_KEYS) {
      const message = stringField(error, key);
      if (message !== undefined) return message;
    }
  }

  const errors = value['errors'];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const message = extractApiErrorMessage(item);
      if (message !== undefined) return message;
    }
  }

  return undefined;
}

export async function readApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return fallback;
  }

  return extractApiErrorMessage(parsed) ?? fallback;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return nonEmptyString(record[key]);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
