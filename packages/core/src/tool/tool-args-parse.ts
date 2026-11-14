/**
 * Parses raw tool call arguments (JSON string, object, or empty) into a value, reporting malformed JSON
 * instead of throwing.
 */

export function parseToolCallArguments(raw: unknown): {
  readonly data: unknown;
  readonly parseFailed: boolean;
  readonly error?: string;
} {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.length === 0)) {
    return { data: {}, parseFailed: false };
  }
  if (typeof raw !== 'string') {
    return { data: raw, parseFailed: false };
  }
  try {
    return { data: JSON.parse(raw) as unknown, parseFailed: false };
  } catch (error) {
    return {
      data: {},
      parseFailed: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rewrites well-known argument aliases onto their canonical names before schema validation. An alias
 * only fills a canonical argument when that argument is absent, so an explicit canonical value always
 * wins; the alias key is always removed. The input object is never mutated.
 */
export function applyToolArgAliases(
  aliases: Readonly<Record<string, string>> | undefined,
  args: unknown,
): unknown {
  if (aliases === undefined) {
    return args;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return args;
  }
  const record = args as Record<string, unknown>;
  let next: Record<string, unknown> | undefined;
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!(alias in record)) {
      continue;
    }
    next ??= { ...record };
    if (!(canonical in record)) {
      next[canonical] = record[alias];
    }
    delete next[alias];
  }
  return next ?? args;
}
