import { errorMessage } from './errors';

export type ParseToolArgsResult = {
  readonly success: true;
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
};

export function parseToolCallArguments(raw: string | null): ParseToolArgsResult {
  if (raw === null || raw.length === 0) {
    return { success: true, data: {}, parseFailed: false };
  }

  try {
    return { success: true, data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    return {
      success: true,
      data: {},
      parseFailed: true,
      error: errorMessage(error),
    };
  }
}
