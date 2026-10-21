export type ParamField =
  | { readonly kind: 'value'; readonly name: string; readonly defaultValue?: string }
  | {
      readonly kind: 'object';
      readonly name: string;
      readonly keys: readonly string[];
      readonly defaultValue?: string;
    }
  | { readonly kind: 'raw'; readonly label: string };

export function fieldKey(index: number, key?: string): string {
  return key === undefined ? String(index) : `${index}.${key}`;
}

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

function objectPatternKey(entry: string): string {
  const colon = entry.indexOf(':');
  const eq = indexOfTopLevelEquals(entry);
  let end = entry.length;
  if (colon !== -1) end = Math.min(end, colon);
  if (eq !== -1) end = Math.min(end, eq);
  return entry.slice(0, end).trim();
}

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

export function smartParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      return raw.slice(1, -1).replaceAll(/\\(.)/g, '$1');
    }
    return raw;
  }
}

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
