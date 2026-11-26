import {
  BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
  isBusinessMembershipRevokedCode,
} from './business-membership';
import { isRecord } from './utils';

const DIRECT_ERROR_KEYS = ['error_description', 'message', 'detail'] as const;
const NESTED_ERROR_KEYS = ['message', 'error_description', 'detail', 'code', 'type'] as const;

export interface ApiErrorDetails {
  readonly message: string;
  readonly code?: string;
  readonly type?: string;
}

export function extractApiErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value['error'];
  if (isRecord(error)) {
    const nestedCode = stringField(error, 'code');
    if (nestedCode !== undefined) return nestedCode;
  }
  const directCode = stringField(value, 'code');
  if (directCode !== undefined) return directCode;
  return nonEmptyString(error);
}

function extractApiErrorType(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value['error'];
  if (isRecord(error)) {
    const nestedType = stringField(error, 'type');
    if (nestedType !== undefined) return nestedType;
  }
  return stringField(value, 'type');
}

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

export async function readApiErrorDetails(
  response: Response,
  fallback: string,
): Promise<ApiErrorDetails> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { message: fallback };
  }

  const code = extractApiErrorCode(parsed);
  const type = extractApiErrorType(parsed);
  const message =
    response.status === 401 && isBusinessMembershipRevokedCode(code)
      ? BUSINESS_MEMBERSHIP_REVOKED_MESSAGE
      : (extractApiErrorMessage(parsed) ?? fallback);

  return {
    message,
    ...(code !== undefined ? { code } : {}),
    ...(type !== undefined ? { type } : {}),
  };
}

export async function readApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  return (await readApiErrorDetails(response, fallback)).message;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return nonEmptyString(record[key]);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
