import { encode } from '@toon-format/toon';
import type { BrowserElementsSnapshot, BrowserRunResult } from '../../shared/browser-automation';

export function elementRows(snapshot: BrowserElementsSnapshot) {
  return snapshot.elements.map(element => ({
    ref: element.ref, role: element.role, name: element.name,
    text: element.text && element.text !== element.name ? element.text : null,
    value: element.value ?? null,
    state: [element.disabled ? 'disabled' : '', element.checked === undefined ? '' : element.checked ? 'checked' : 'unchecked',
      element.selected ? 'selected' : '', element.expanded === undefined ? '' : element.expanded ? 'expanded' : 'collapsed',
      element.inViewport ? '' : 'offscreen'].filter(Boolean).join(' ') || null,
  }));
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, withoutUndefined(entry)]));
}

function projectBrowserToolResult(result: BrowserRunResult): Record<string, unknown> {
  const { visual, crop, elements, ...rest } = result;
  const projected: Record<string, unknown> = { ...rest };
  if (visual !== undefined) {
    const { data: _data, ...metadata } = visual;
    projected['visual'] = metadata;
  }
  if (crop !== undefined) {
    const { data: _data, ...metadata } = crop;
    projected['crop'] = metadata;
  }
  if (elements !== undefined) projected['elements'] = { ...elements, elements: elementRows(elements) };
  return projected;
}

export function formatBrowserToolResult(result: BrowserRunResult): string {
  return encode(withoutUndefined(projectBrowserToolResult(result)));
}
