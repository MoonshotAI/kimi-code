export interface SelectToolsResult {
  loaded: string[];
  alreadyAvailable: string[];
  unknown: string[];
  notes: string[];
}

export function parseSelectToolsNames(arg: string): string[] {
  try {
    const value: unknown = JSON.parse(arg);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const names = (value as Record<string, unknown>).names;
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.some((name) => typeof name !== 'string' || name.length === 0)
    ) {
      return [];
    }
    return names as string[];
  } catch {
    return [];
  }
}

function parseNameList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function parseSelectToolsResult(text: string): SelectToolsResult {
  const result: SelectToolsResult = {
    loaded: [],
    alreadyAvailable: [],
    unknown: [],
    notes: [],
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('Loaded:')) {
      result.loaded.push(...parseNameList(trimmed.slice('Loaded:'.length)));
      continue;
    }
    if (trimmed.startsWith('Already available:')) {
      result.alreadyAvailable.push(...parseNameList(trimmed.slice('Already available:'.length)));
      continue;
    }
    if (trimmed.startsWith('Unknown tool:')) {
      const rest = trimmed.slice('Unknown tool:'.length).trim();
      const token = rest.split(/\s/, 1)[0] ?? '';
      const name = token.endsWith('.') ? token.slice(0, -1) : token;
      if (name.length > 0) result.unknown.push(name);
      if (name.length === 0 || rest.length > token.length) result.notes.push(line);
      continue;
    }
    result.notes.push(line);
  }
  return result;
}
