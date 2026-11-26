import type { ViewPart } from '#/model/types';

export function contentPartsOf(content: unknown, partOf: (part: Record<string, unknown>, raw: unknown) => ViewPart): ViewPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return asArray(content).map((raw) => partOf(asRecord(raw), raw));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function stringOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}
