const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;

export interface NormalizeOptions {
  readonly paths?: Readonly<Record<string, string>>;
  readonly idKeys?: readonly string[];
  readonly timeKeys?: readonly string[];
  readonly uuid?: boolean;
  readonly ulid?: boolean;
  readonly isoTime?: boolean;
}

export type Normalizer = <T>(value: T) => T;

export function createNormalizer(options: NormalizeOptions = {}): Normalizer {
  const tokens = new Map<string, Map<string, string>>();
  const tokenFor = (kind: string, raw: string): string => {
    let byValue = tokens.get(kind);
    if (byValue === undefined) {
      byValue = new Map();
      tokens.set(kind, byValue);
    }
    let token = byValue.get(raw);
    if (token === undefined) {
      token = `<${kind}:${byValue.size + 1}>`;
      byValue.set(raw, token);
    }
    return token;
  };
  const pathReplacements = pathVariants(options.paths ?? {});
  const idKeys = new Set(options.idKeys);
  const timeKeys = new Set(options.timeKeys);

  const normalizeString = (text: string): string => {
    let result = text.replaceAll('\r\n', '\n');
    for (const [raw, token] of pathReplacements) result = result.replaceAll(raw, token);
    if (options.uuid !== false) result = result.replace(UUID, (match) => tokenFor('uuid', match.toLowerCase()));
    if (options.ulid !== false) result = result.replace(ULID, (match) => tokenFor('ulid', match));
    if (options.isoTime !== false) result = result.replace(ISO_TIME, '<time>');
    return result;
  };

  const visit = (value: unknown, key: string | undefined): unknown => {
    if (key !== undefined && timeKeys.has(key) && (typeof value === 'string' || typeof value === 'number')) return '<time>';
    if (key !== undefined && idKeys.has(key) && typeof value === 'string') return tokenFor(key, value);
    if (typeof value === 'string') return normalizeString(value);
    if (Array.isArray(value)) return value.map((item) => visit(item, undefined));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, visit(entry, entryKey)]));
    }
    return value;
  };

  return <T>(value: T): T => visit(value, undefined) as T;
}

export function normalize<T>(value: T, options: NormalizeOptions = {}): T {
  return createNormalizer(options)(value);
}

function pathVariants(paths: Readonly<Record<string, string>>): Array<readonly [string, string]> {
  const variants: Array<readonly [string, string]> = [];
  for (const [token, path] of Object.entries(paths)) {
    if (path === '') continue;
    const forms = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')]);
    if (path.startsWith('/private/')) forms.add(path.slice('/private'.length));
    else if (path.startsWith('/var/') || path.startsWith('/tmp/')) forms.add(`/private${path}`);
    for (const form of forms) variants.push([form, token]);
  }
  return variants.toSorted((left, right) => right[0].length - left[0].length);
}
