export function normalizeRecording(value: unknown): unknown {
  const ids = new Map<string, string>();
  function visit(item: unknown, field: string): unknown {
    if (Array.isArray(item)) return item.map(v => visit(v, field));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v, k)]));
    if (typeof item === 'string' && ['session_id', 'turn_id', 'item_id', 'prompt_ids'].includes(field)) {
      if (!ids.has(item)) ids.set(item, `recorded-${ids.size + 1}`);
      return ids.get(item);
    }
    if (typeof item === 'string' && ['event_created_at', 'created_at', 'started_at', 'ended_at'].includes(field)) return '2000-01-01T00:00:00.000Z';
    if (typeof item === 'number' && field === 'duration_ms') return 0;
    return item;
  }
  return visit(value, '');
}
