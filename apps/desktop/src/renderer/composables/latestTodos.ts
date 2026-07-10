// apps/kimi-web/src/composables/latestTodos.ts
// Derives the CURRENT todo list from a session transcript. The model manages
// todos via the TodoList tool: every write carries the FULL list in
// `input.todos` (an empty array clears it), and a call without `todos` is a
// read-only query. So the newest toolUse that carries a `todos` array is the
// current state — older calls and queries don't matter.

import type { AppMessage } from '../api/types';
import type { TodoView } from '../types';
import { normalizeToolName } from '../lib/toolMeta';

function toStatus(raw: unknown): TodoView['status'] {
  if (raw === 'in_progress') return 'in_progress';
  // Kimi's TodoList says 'done'; Claude-style TodoWrite says 'completed'.
  if (raw === 'done' || raw === 'completed') return 'done';
  return 'pending';
}

export function latestTodos(messages: AppMessage[]): TodoView[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant') continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const c = msg.content[j]!;
      if (c.type !== 'toolUse' || normalizeToolName(c.toolName) !== 'todo') continue;
      let input: unknown = c.input;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          continue;
        }
      }
      const todos = (input as { todos?: unknown } | null)?.todos;
      if (!Array.isArray(todos)) continue; // read-only query — keep looking back
      return todos.flatMap((item) => {
        const it = (item ?? {}) as Record<string, unknown>;
        const title =
          typeof it['title'] === 'string'
            ? it['title']
            : typeof it['content'] === 'string'
              ? it['content']
              : '';
        return title ? [{ title, status: toStatus(it['status']) }] : [];
      });
    }
  }
  return [];
}
