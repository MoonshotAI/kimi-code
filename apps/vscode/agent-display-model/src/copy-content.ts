import type { DisplayBlock, DisplayPart, DisplayPlanEntry, DisplayTodoItem } from './model';

function nonEmptyText(text: string | null | undefined): string | null {
  if (!text || text.trim().length === 0) return null;
  return text;
}

function formatPlanEntry(entry: DisplayPlanEntry): string {
  const priority = entry.priority ? ` (${entry.priority})` : '';
  return `- [${entry.status}] ${entry.content}${priority}`;
}

function formatTodoItem(item: DisplayTodoItem): string {
  return `- [${item.status}] ${item.title}`;
}

function summarizeDisplayBlock(block: DisplayBlock): string | null {
  switch (block.type) {
    case 'brief':
      return nonEmptyText(block.text);
    case 'diff':
      return `Diff: ${block.path}`;
    case 'todo': {
      const items = block.items.map(formatTodoItem);
      return items.length > 0 ? ['Todo:', ...items].join('\n') : null;
    }
    case 'command': {
      const lines = [`Command (${block.language}): ${block.command}`];
      if (block.cwd) lines.push(`cwd: ${block.cwd}`);
      if (block.danger) lines.push(`Danger: ${block.danger}`);
      if (block.description) lines.push(block.description);
      return lines.join('\n');
    }
    case 'file-op': {
      const detail = block.detail ? `\n${block.detail}` : '';
      return `${block.operation} ${block.path}${detail}`;
    }
    case 'file-content':
      return [`File: ${block.path}`, block.content].join('\n');
    case 'url-fetch':
      return `${block.method ?? 'GET'} ${block.url}`;
    case 'search': {
      const scope = block.scope ? `\nscope: ${block.scope}` : '';
      return `Search: ${block.query}${scope}`;
    }
    case 'invocation': {
      const description = block.description ? `\n${block.description}` : '';
      return `${block.kind}: ${block.name}${description}`;
    }
    case 'background-task': {
      const description = block.description ? `: ${block.description}` : '';
      return `Background task ${block.taskId} (${block.kind}, ${block.status})${description}`;
    }
  }
}

function summarizeDisplayBlocks(blocks: DisplayBlock[] | undefined): string | null {
  const summaries = (blocks ?? []).map(summarizeDisplayBlock).filter((block): block is string => block !== null);
  return summaries.length > 0 ? summaries.join('\n\n') : null;
}

function formatToolCall(part: Extract<DisplayPart, { type: 'tool-call' }>): string | null {
  const sections = [`Tool: ${part.name}`, `Status: ${part.status}`];
  const args = nonEmptyText(part.argumentsText);
  const result = nonEmptyText(part.resultText);
  const display = summarizeDisplayBlocks(part.displayBlocks);

  if (args) sections.push('', 'Arguments:', args);
  if (result) sections.push('', 'Result:', result);
  if (display) sections.push('', 'Display:', display);

  return sections.join('\n');
}

export function getDisplayPartCopyContent(part: DisplayPart): string | null {
  switch (part.type) {
    case 'text':
      return nonEmptyText(part.text);
    case 'thinking':
      return part.finished ? nonEmptyText(part.text) : null;
    case 'media':
      return `[${part.kind}${part.id ? ` ${part.id}` : part.url ? ` ${part.url}` : ''}]`;
    case 'plan': {
      const entries = part.plan.entries.map(formatPlanEntry);
      return entries.length > 0 ? entries.join('\n') : null;
    }
    case 'tool-call':
      return formatToolCall(part);
    case 'approval':
    case 'compaction':
    case 'error':
    case 'interrupt':
    case 'status':
      return null;
  }
}
