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
 * Rewrites well-known argument aliases (e.g. `offset` -> `line_offset`) to the
 * canonical names declared by a tool's schema, before runtime validation.
 * Models trained on other agent/file-reading tools frequently emit `offset`/
 * `limit` where a tool declares `line_offset`/`n_lines`, which would otherwise
 * fail strict schema validation and discard the whole turn.
 *
 * An alias is only applied when the canonical argument is absent, so an
 * explicitly provided canonical value always takes precedence. The input is
 * returned unchanged when there is nothing to rewrite.
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
      // Only adopt the alias value when the canonical argument is absent;
      // an explicitly provided canonical value always takes precedence.
      next[canonical] = record[alias];
    }
    delete next[alias];
  }
  return next ?? args;
}
