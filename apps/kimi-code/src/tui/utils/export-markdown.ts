import type { ContentPart, ContextMessage, PromptOrigin, ToolCall } from '@moonshot-ai/kimi-code-sdk';

const HINT_KEYS = ['path', 'file_path', 'command', 'query', 'url', 'name', 'pattern'] as const;

const MAX_HINT_WIDTH = 60;

export function extractToolCallHint(argsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';

  const args = parsed as Record<string, unknown>;

  for (const key of HINT_KEYS) {
    const val = args[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return shorten(val, MAX_HINT_WIDTH);
    }
  }

  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.length > 0 && val.length <= 80) {
      return shorten(val, MAX_HINT_WIDTH);
    }
  }

  return '';
}

function shorten(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, width)}…`;
}

export function formatContentPartMd(part: ContentPart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'think':
      if (!part.think.trim()) return '';
      return `<details><summary>Thinking</summary>\n\n${part.think}\n\n</details>`;
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    default:
      return `[${(part as ContentPart).type}]`;
  }
}

export function formatToolCallMd(tc: ToolCall): string {
  const argsRaw = tc.arguments ?? '{}';
  const hint = extractToolCallHint(argsRaw);
  let title = `#### Tool Call: ${tc.name}`;
  if (hint) {
    title += ` (\`${hint}\`)`;
  }

  let argsFormatted: string;
  try {
    argsFormatted = JSON.stringify(JSON.parse(argsRaw), null, 2);
  } catch {
    argsFormatted = argsRaw;
  }

  return `${title}\n<!-- call_id: ${tc.id} -->\n\`\`\`json\n${argsFormatted}\n\`\`\``;
}

function formatToolResultMd(msg: ContextMessage, toolName: string, hint: string): string {
  const callId = msg.toolCallId ?? 'unknown';
  const parts: string[] = [];
  for (const part of msg.content) {
    const text = formatContentPartMd(part);
    if (text.trim()) parts.push(text);
  }
  const resultText = parts.join('\n');

  let summary = `Tool Result: ${toolName}`;
  if (hint) summary += ` (\`${hint}\`)`;

  return (
    `<details><summary>${summary}</summary>\n\n` +
    `<!-- call_id: ${callId} -->\n` +
    `${resultText}\n\n` +
    '</details>'
  );
}

const INTERNAL_ORIGINS = new Set<PromptOrigin['kind']>([
  'injection',
  'system_trigger',
  'compaction_summary',
  'hook_result',
  // Cron fires are stored as user-role records carrying a `<cron-fire ...>`
  // XML envelope meant only for the model. Replay and the TUI projector
  // already hide them; the markdown exporter must do the same or the raw
  // protocol XML leaks into the user-facing export.
  'cron_job',
  'cron_missed',
]);

export function isInternalMessage(msg: ContextMessage): boolean {
  const origin = msg.origin;
  if (origin === undefined) return false;
  return INTERNAL_ORIGINS.has(origin.kind);
}

export function groupIntoTurns(history: readonly ContextMessage[]): ContextMessage[][] {
  const turns: ContextMessage[][] = [];
  let current: ContextMessage[] = [];

  for (const msg of history) {
    if (isInternalMessage(msg)) continue;
    if (msg.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(msg);
  }

  if (current.length > 0) turns.push(current);
  return turns;
}

function formatTurnMd(messages: readonly ContextMessage[], turnNumber: number): string {
  const lines: string[] = [`## Turn ${String(turnNumber)}`, ''];

  const toolCallInfo = new Map<string, { name: string; hint: string }>();
  let assistantHeaderWritten = false;

  for (const msg of messages) {
    if (isInternalMessage(msg)) continue;

    if (msg.role === 'user') {
      lines.push('### User', '');
      for (const part of msg.content) {
        const text = formatContentPartMd(part);
        if (text.trim()) {
          lines.push(text, '');
        }
      }
    } else if (msg.role === 'assistant') {
      if (!assistantHeaderWritten) {
        lines.push('### Assistant', '');
        assistantHeaderWritten = true;
      }

      for (const part of msg.content) {
        const text = formatContentPartMd(part);
        if (text.trim()) {
          lines.push(text, '');
        }
      }

      for (const tc of msg.toolCalls) {
        const hint = extractToolCallHint(tc.arguments ?? '{}');
        toolCallInfo.set(tc.id, { name: tc.name, hint });
        lines.push(formatToolCallMd(tc), '');
      }
    } else if (msg.role === 'tool') {
      const tcId = msg.toolCallId ?? '';
      const info = toolCallInfo.get(tcId) ?? { name: 'unknown', hint: '' };
      lines.push(formatToolResultMd(msg, info.name, info.hint), '');
    } else if (msg.role === 'system') {
      lines.push(`### ${msg.role.charAt(0).toUpperCase()}${msg.role.slice(1)}`, '');
      for (const part of msg.content) {
        const text = formatContentPartMd(part);
        if (text.trim()) {
          lines.push(text, '');
        }
      }
    }
  }

  return lines.join('\n');
}

function buildOverview(
  history: readonly ContextMessage[],
  turns: readonly ContextMessage[][],
): string {
  let topic = '';
  for (const msg of history) {
    if (msg.role === 'user' && !isInternalMessage(msg)) {
      const textParts = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text);
      topic = shorten(textParts.join(' '), 80);
      break;
    }
  }

  const toolCallCount = history.reduce(
    (sum, msg) => sum + msg.toolCalls.length,
    0,
  );

  return [
    '## Overview',
    '',
    topic ? `- **Topic**: ${topic}` : '- **Topic**: (empty)',
    `- **Conversation**: ${String(turns.length)} turns | ${String(toolCallCount)} tool calls`,
    '',
    '---',
  ].join('\n');
}

export interface BuildExportMarkdownInput {
  readonly sessionId: string;
  readonly workDir: string;
  readonly history: readonly ContextMessage[];
  readonly tokenCount: number;
  readonly now: Date;
}

export function buildExportMarkdown(input: BuildExportMarkdownInput): string {
  const { sessionId, workDir, history, tokenCount, now } = input;

  const lines: string[] = [
    '---',
    `session_id: ${sessionId}`,
    `exported_at: ${now.toISOString()}`,
    `work_dir: ${workDir}`,
    `message_count: ${String(history.length)}`,
    `token_count: ${String(tokenCount)}`,
    '---',
    '',
    '# Kimi Session Export',
    '',
  ];

  const turns = groupIntoTurns(history);
  lines.push(buildOverview(history, turns));
  lines.push('');

  for (let i = 0; i < turns.length; i++) {
    lines.push(formatTurnMd(turns[i]!, i + 1));
  }

  return lines.join('\n');
}
