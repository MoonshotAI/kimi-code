import type { ToolInputDisplay } from '@moonshot-ai/agent-core';

/**
 * Recover the UI display attached to a legacy top-level ToolResult.
 *
 * Legacy context.jsonl carries the model-facing tool exchange, but the
 * user-facing diff/todo/command display only exists in wire.jsonl. Both files
 * use the same tool-call id, so the migrator can safely join an unambiguous
 * single display block back onto the assistant message that owns the call.
 * Nested SubagentEvent payloads are deliberately ignored here: their child
 * transcript needs a separate agent migration, not a main-context join.
 */
export function extractToolCallDisplays(
  wireText: string,
): ReadonlyMap<string, ToolInputDisplay> {
  const displays = new Map<string, ToolInputDisplay>();
  const seenToolCallIds = new Set<string>();

  for (const rawLine of wireText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const record = asRecord(parsed);
    const message = asRecord(record?.['message']);
    if (message?.['type'] !== 'ToolResult') continue;

    const payload = asRecord(message['payload']);
    const toolCallId = payload?.['tool_call_id'];
    if (typeof toolCallId !== 'string' || toolCallId === '') continue;

    // A duplicate result makes the id-to-display join ambiguous. Do not let a
    // later line silently replace the display chosen from an earlier result.
    if (seenToolCallIds.has(toolCallId)) {
      displays.delete(toolCallId);
      continue;
    }
    seenToolCallIds.add(toolCallId);

    if (payload === undefined) continue;
    const returnValue = asRecord(payload['return_value']);
    const legacyDisplays = returnValue?.['display'];
    if (!Array.isArray(legacyDisplays) || legacyDisplays.length !== 1) continue;

    const display = translateDisplayBlock(legacyDisplays[0]);
    if (display !== undefined) displays.set(toolCallId, display);
  }

  return displays;
}

function translateDisplayBlock(raw: unknown): ToolInputDisplay | undefined {
  const block = asRecord(raw);
  if (block === undefined) return undefined;

  switch (block['type']) {
    case 'diff': {
      const path = block['path'];
      const before = block['old_text'];
      const after = block['new_text'];
      if (typeof path !== 'string' || typeof before !== 'string' || typeof after !== 'string') {
        return undefined;
      }
      return { kind: 'diff', path, before, after };
    }
    case 'todo': {
      const items = block['items'];
      if (!Array.isArray(items)) return undefined;
      const normalizedItems: Array<{ title: string; status: string }> = [];
      for (const rawItem of items) {
        const item = asRecord(rawItem);
        const title = item?.['title'];
        const status = item?.['status'];
        if (typeof title !== 'string' || typeof status !== 'string') return undefined;
        normalizedItems.push({ title, status });
      }
      return { kind: 'todo_list', items: normalizedItems };
    }
    case 'shell': {
      const command = block['command'];
      const language = block['language'];
      if (typeof command !== 'string' || language !== 'bash') return undefined;
      return { kind: 'command', command, language: 'bash' };
    }
    case 'brief': {
      const summary = block['text'];
      if (typeof summary !== 'string') return undefined;
      return { kind: 'generic', summary };
    }
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
