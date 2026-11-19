import { isMap, isScalar, parseDocument, stringify } from 'yaml';

export interface FrontmatterEntry {
  key: string;
  value: string;
  tags: string[] | null;
}

function displayValue(value: unknown): string {
  if (value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stringify(value).trimEnd();
}

export function frontmatterMetadata(source: string): FrontmatterEntry[] | null {
  if (source.length > 65_536) return null;
  try {
    const doc = parseDocument(source, { schema: 'core' });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return null;
    if (!doc.contents.items.every(({ key }) => isScalar(key) && typeof key.value === 'string')) return null;
    const values = doc.toJS({ mapAsMap: true, maxAliasCount: 0 }) as Map<string, unknown>;
    if (values.size === 0) return null;
    return Array.from(values, ([key, value]) => ({
      key,
      value: displayValue(value),
      tags: Array.isArray(value) && value.length > 0 && value.every((item) => item === null || typeof item !== 'object')
        ? value.map(displayValue)
        : null,
    }));
  } catch {
    return null;
  }
}
