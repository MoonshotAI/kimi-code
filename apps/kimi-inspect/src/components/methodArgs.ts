/**
 * Structured method-argument editing for the dynamic Service cards, driven
 * only by the wire `params` string (the declared parameter list parsed from
 * `Function#toString` server-side — names only, no per-method schemas).
 *
 * `parseParamFields` splits the params string into editable fields:
 * - a named parameter (`title`, `count = 1`) becomes one input; an empty
 *   input falls back to the declared default;
 * - a destructured object parameter (`{ workspaceId, limit }`) becomes one
 *   input per key, assembled back into an object (empty keys are dropped);
 * - anything unparseable (rest params, array patterns) falls back to one
 *   raw JSON input — the old behavior.
 *
 * Field values are smart-parsed (`smartParse`): text that parses as JSON is
 * passed through parsed (numbers, booleans, objects, quoted strings),
 * anything else goes as a plain string — so `main` needs no quotes while
 * `{ "a": 1 }` still works.
 */

export type ParamField =
  | { readonly kind: 'value'; readonly name: string; readonly defaultValue?: string }
  | {
      readonly kind: 'object';
      /** Original pattern text, used as the group label (e.g. `{ workspaceId, limit }`). */
      readonly name: string;
      readonly keys: readonly string[];
      readonly defaultValue?: string;
    }
  | { readonly kind: 'raw'; readonly label: string };

/** Input state key for a field: the param index, or `index.key` for object keys. */
export function fieldKey(index: number, key?: string): string {
  return key === undefined ? String(index) : `${index}.${key}`;
}

/**
 * Split a parameter list at top-level commas, tracking `(){}[]` nesting and
 * string literals (defaults can contain commas, e.g. `= ['a', 'b']`).
 */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

/** Index of the first `=` at nesting depth 0 (skipping `=>`, `==`, `===`), or -1. */
function indexOfTopLevelEquals(src: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === '=' && depth === 0 && src[i + 1] !== '=' && src[i + 1] !== '>') return i;
  }
  return -1;
}

/** Index of the `}` matching the `{` at position 0 of `src`, or -1. */
function matchingBrace(src: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Property name out of one object-pattern entry: `a`, `a: b`, `a = 1`, `a: b = 1` → `a`. */
function objectPatternKey(entry: string): string {
  const colon = entry.indexOf(':');
  const eq = indexOfTopLevelEquals(entry);
  let end = entry.length;
  if (colon !== -1) end = Math.min(end, colon);
  if (eq !== -1) end = Math.min(end, eq);
  return entry.slice(0, end).trim();
}

/** Parse the wire `params` string into editable fields (see file header). */
export function parseParamFields(params: string): readonly ParamField[] {
  return splitTopLevel(params)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((part): ParamField => {
      if (part.startsWith('{')) {
        const close = matchingBrace(part);
        if (close === -1) return { kind: 'raw', label: part };
        const keys = splitTopLevel(part.slice(1, close))
          .map((k) => objectPatternKey(k.trim()))
          .filter((k) => k !== '' && !k.startsWith('...'));
        const rest = part.slice(close + 1).trim();
        const defaultValue = rest.startsWith('=') ? rest.slice(1).trim() : undefined;
        if (keys.length === 0) return { kind: 'raw', label: part };
        return { kind: 'object', name: part, keys, defaultValue };
      }
      if (part.startsWith('[') || part.startsWith('...')) {
        return { kind: 'raw', label: part };
      }
      const eq = indexOfTopLevelEquals(part);
      if (eq !== -1) {
        const name = part.slice(0, eq).trim();
        const defaultValue = part.slice(eq + 1).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) return { kind: 'value', name, defaultValue };
        return { kind: 'raw', label: part };
      }
      if (/^[A-Za-z_$][\w$]*$/.test(part)) return { kind: 'value', name: part };
      return { kind: 'raw', label: part };
    });
}

/** Smart-parse one field value: JSON when it parses, the raw string otherwise. */
export function smartParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Declared defaults are source text, where strings use JS single-quote
    // literals ('auto') that JSON.parse rejects — unquote those.
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      return raw.slice(1, -1).replaceAll(/\\(.)/g, '$1');
    }
    return raw;
  }
}

/**
 * Assemble the wire argument array from field inputs (keyed by `fieldKey`).
 * Empty value fields fall back to their declared default; empty object
 * fields drop the key, and a fully-empty object param is omitted. Trailing
 * holes are truncated; interior holes serialize as `null` on the wire.
 * Throws when a raw field contains invalid JSON.
 */
export function buildArgs(
  fields: readonly ParamField[],
  values: Readonly<Record<string, string>>,
): unknown[] {
  const args: unknown[] = [];
  fields.forEach((field, i) => {
    if (field.kind === 'value') {
      const raw = (values[fieldKey(i)] ?? '').trim();
      if (raw !== '') args[i] = smartParse(raw);
      else if (field.defaultValue !== undefined) args[i] = smartParse(field.defaultValue);
      else args[i] = undefined;
    } else if (field.kind === 'object') {
      const obj: Record<string, unknown> = {};
      let filled = false;
      for (const key of field.keys) {
        const raw = (values[fieldKey(i, key)] ?? '').trim();
        if (raw !== '') {
          obj[key] = smartParse(raw);
          filled = true;
        }
      }
      args[i] = filled ? obj : undefined;
    } else {
      const raw = (values[fieldKey(i)] ?? '').trim();
      if (raw !== '') args[i] = JSON.parse(raw);
      else args[i] = undefined;
    }
  });
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  return args.slice(0, end);
}
