/**
 * Claude Code session parser.
 *
 * Reads `~/.claude/projects/{encoded_cwd}/{sessionId}.jsonl` files and converts
 * them into a unified {@link HandoffContext} for import into Kimi Code.
 *
 * Session format reference (reverse-engineered from cli-continues and real files):
 *   - JSONL with one JSON object per line
 *   - Entry types: user, assistant, system, queue-operation, attachment,
 *     file-history-snapshot, ai-title, last-prompt, progress
 *   - Only `user` and `assistant` entries carry conversation content
 *   - Content blocks: text, thinking, tool_use, tool_result
 *   - Subagent data in `{sessionId}/subagents/agent-*.jsonl`
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  ConversationTurn,
  FileChangeRecord,
  HandoffContext,
  HandoffTokenUsage,
  SourceParser,
  SourceSessionSummary,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const MAX_RECENT_TURNS = 30;
const MAX_THINKING_CHARS = 500;
const MAX_TOOL_INPUT_CHARS = 200;

// ---------------------------------------------------------------------------
// CC-specific raw types (subset of what real JSONL files contain)
// ---------------------------------------------------------------------------

interface CCRawMessage {
  role: 'user' | 'assistant';
  content: string | CCRawContentBlock[];
}

type CCRawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

interface CCRawEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  message?: CCRawMessage;
  // Top-level tool result (Bash, WebSearch, etc.)
  toolUseResult?: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    query?: string;
    durationSeconds?: number;
  };
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/**
 * Reverse the CC directory-name encoding: every non-alphanumeric char in the
 * absolute path is replaced by '-'. We try common prefix patterns to recover
 * a human-readable path.
 */
function decodeProjectPath(encoded: string): string {
  // The encoding replaces ALL non-alphanumeric chars with '-'.
  // The common prefix on macOS is "-Users-username-..."
  // We convert leading hyphens back to '/', then guess at the structure.
  let decoded = encoded;
  // Leading '-' represents '/'
  if (decoded.startsWith('-')) {
    decoded = '/' + decoded.slice(1);
  }
  // Heuristic: every '-' that separates known path segments could be '/'
  // For display purposes we keep the encoded form — exact reverse is lossy.
  return decoded;
}

function resolveClaudeConfigDir(): string {
  const envDir = process.env['CLAUDE_CONFIG_DIR'];
  if (envDir !== undefined && envDir.length > 0) {
    return join(envDir, 'projects');
  }
  return CLAUDE_PROJECTS_DIR;
}

async function discoverSessionFiles(projectsDir: string): Promise<string[]> {
  const files: string[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return files; // ~/.claude/projects doesn't exist
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(projectsDir, projectDir);
    let st: { isDirectory(): boolean };
    try {
      st = await stat(projectPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let entries: string[];
    try {
      entries = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      // Newer layout: sessions/{uuid}.jsonl
      if (entry === 'sessions') {
        const sessionsDir = join(projectPath, 'sessions');
        try {
          const sessionFiles = await readdir(sessionsDir);
          for (const sf of sessionFiles) {
            if (sf.endsWith('.jsonl') && sf.length > 36) {
              files.push(join(sessionsDir, sf));
            }
          }
        } catch {
          // ignore
        }
        continue;
      }

      // Legacy layout: {uuid}.jsonl directly in project dir
      if (entry.endsWith('.jsonl') && entry.length > 36) {
        files.push(join(projectPath, entry));
      }
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

async function* readEntries(filePath: string): AsyncGenerator<CCRawEntry> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' });
  } catch {
    return;
  }

  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      yield JSON.parse(trimmed) as CCRawEntry;
    } catch {
      // Skip malformed lines
    }
  }
}

function isConversationEntry(entry: CCRawEntry): boolean {
  return entry.type === 'user' || entry.type === 'assistant';
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function extractTextFromBlocks(blocks: CCRawContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function extractThinkingFromBlocks(blocks: CCRawContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('\n')
    .trim();
}

function extractToolCallsFromBlocks(
  blocks: CCRawContentBlock[],
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return blocks
    .filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use',
    )
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

function extractToolResultsFromBlocks(
  blocks: CCRawContentBlock[],
): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
  return blocks
    .filter(
      (
        b,
      ): b is {
        type: 'tool_result';
        tool_use_id: string;
        content: unknown;
        is_error?: boolean;
      } => b.type === 'tool_result',
    )
    .map((b) => ({ tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }));
}

// ---------------------------------------------------------------------------
// Tool result summarisation
// ---------------------------------------------------------------------------

function summariseToolResult(
  toolName: string,
  toolInput: Record<string, unknown>,
  ccEntry: CCRawEntry,
): string {
  const tur = ccEntry.toolUseResult;

  switch (toolName) {
    case 'Bash':
    case 'bash': {
      const cmd =
        typeof toolInput['command'] === 'string'
          ? toolInput['command']
          : typeof toolInput['cmd'] === 'string'
            ? toolInput['cmd']
            : '(unknown command)';
      if (tur !== undefined) {
        const code = tur.exitCode ?? '?';
        return `\`${truncateText(cmd, 80)}\` — exit code ${String(code)}`;
      }
      return `\`${truncateText(cmd, 80)}\``;
    }

    case 'Read':
    case 'read': {
      const fp =
        typeof toolInput['file_path'] === 'string'
          ? toolInput['file_path']
          : typeof toolInput['filePath'] === 'string'
            ? toolInput['filePath']
            : '(unknown file)';
      return `Read \`${fp}\``;
    }

    case 'Write':
    case 'write':
    case 'Edit':
    case 'edit': {
      const fp =
        typeof toolInput['file_path'] === 'string'
          ? toolInput['file_path']
          : typeof toolInput['filePath'] === 'string'
            ? toolInput['filePath']
            : '(unknown file)';
      return `${toolName} \`${fp}\``;
    }

    case 'Glob':
    case 'glob':
    case 'Grep':
    case 'grep': {
      const pattern =
        typeof toolInput['pattern'] === 'string' ? toolInput['pattern'] : '(unknown pattern)';
      return `${toolName} \`${truncateText(pattern, 60)}\``;
    }

    case 'WebSearch':
    case 'web_search': {
      const query = tur?.query ?? toolInput['query'];
      return typeof query === 'string'
        ? `Web search: "${truncateText(query, 80)}"`
        : 'Web search';
    }

    case 'WebFetch':
    case 'web_fetch': {
      const url = toolInput['url'];
      return typeof url === 'string' ? `Fetch: ${truncateText(url, 80)}` : 'Web fetch';
    }

    case 'Task':
    case 'task':
    case 'Agent':
    case 'agent': {
      const desc =
        typeof toolInput['description'] === 'string'
          ? toolInput['description']
          : typeof toolInput['prompt'] === 'string'
            ? toolInput['prompt']
            : '(subagent)';
      return `Subagent: ${truncateText(desc, 100)}`;
    }

    default:
      return `${toolName}`;
  }
}

// ---------------------------------------------------------------------------
// File change extraction
// ---------------------------------------------------------------------------

function extractFileChanges(
  entries: CCRawEntry[],
  workingDirectory?: string,
): FileChangeRecord[] {
  const editsByPath = new Map<string, Set<string>>();
  const readPaths = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== 'assistant' || entry.message === undefined) continue;
    const blocks = ensureBlocks(entry.message.content);
    for (const tc of extractToolCallsFromBlocks(blocks)) {
      const fp = getFilePath(tc.name, tc.input);
      if (fp === undefined) continue;

      const relPath = resolveRelativePath(fp, workingDirectory);
      if (isEditTool(tc.name)) {
        const descriptions = editsByPath.get(relPath) ?? new Set();
        descriptions.add(summariseToolResult(tc.name, tc.input, entry));
        editsByPath.set(relPath, descriptions);
      } else if (tc.name === 'Read' || tc.name === 'read') {
        readPaths.add(relPath);
      }
    }
  }

  const records: FileChangeRecord[] = [];
  for (const [path, descriptions] of editsByPath) {
    records.push({ path, description: [...descriptions].join('; ') });
  }
  // Include files that were read but not edited (context)
  for (const path of readPaths) {
    if (!editsByPath.has(path)) {
      records.push({ path, description: 'Read (no edits)' });
    }
  }

  return records;
}

function isEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === 'write' || name === 'edit';
}

function getFilePath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const name = toolName.toLowerCase();
  if (
    name === 'read' ||
    name === 'write' ||
    name === 'edit' ||
    name === 'grep' ||
    name === 'glob'
  ) {
    return (
      (input['file_path'] as string) ??
      (input['filePath'] as string) ??
      (input['path'] as string)
    );
  }
  return undefined;
}

function resolveRelativePath(absolutePath: string, workingDirectory?: string): string {
  if (workingDirectory !== undefined && absolutePath.startsWith(workingDirectory)) {
    return relative(workingDirectory, absolutePath);
  }
  return absolutePath;
}

// ---------------------------------------------------------------------------
// Token counting
// ---------------------------------------------------------------------------

function aggregateTokenUsage(entries: CCRawEntry[]): HandoffTokenUsage | undefined {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    // Usage is nested in the API message
    const msg = entry.message as Record<string, unknown> | undefined;
    const usage = msg?.['usage'] as Record<string, number> | undefined;
    if (usage === undefined) continue;

    input += usage['input_tokens'] ?? 0;
    output += usage['output_tokens'] ?? 0;
    cacheRead += usage['cache_read_input_tokens'] ?? 0;
    cacheCreation += usage['cache_creation_input_tokens'] ?? 0;
  }

  if (input === 0 && output === 0) return undefined;
  return { input, output, cacheRead: cacheRead > 0 ? cacheRead : undefined, cacheCreation: cacheCreation > 0 ? cacheCreation : undefined };
}

// ---------------------------------------------------------------------------
// Pending work detection
// ---------------------------------------------------------------------------

const PENDING_KEYWORDS = ['need to', 'next step', 'todo', 'remaining', 'pending'];

function extractPendingWork(thinkingBlocks: string[]): string[] {
  const unique = new Set<string>();
  for (const think of thinkingBlocks) {
    const lower = think.toLowerCase();
    if (PENDING_KEYWORDS.some((kw) => lower.includes(kw))) {
      unique.add(truncateText(think.trim(), 200));
    }
    if (unique.size >= 5) break;
  }
  return [...unique];
}

// ---------------------------------------------------------------------------
// Handoff Markdown generation
// ---------------------------------------------------------------------------

function generateHandoffMarkdown(ctx: Omit<HandoffContext, 'markdown'>): string {
  const lines: string[] = [];

  // YAML frontmatter
  lines.push('---');
  lines.push(`source: ${ctx.source}`);
  lines.push(`sourceSessionId: "${ctx.sourceSessionId}"`);
  if (ctx.model !== undefined) lines.push(`model: "${ctx.model}"`);
  if (ctx.createdAt !== undefined) lines.push(`createdAt: "${ctx.createdAt}"`);
  if (ctx.workingDirectory !== undefined) lines.push(`workingDirectory: "${ctx.workingDirectory}"`);
  if (ctx.tokenUsage !== undefined) {
    lines.push('tokenUsage:');
    lines.push(`  input: ${String(ctx.tokenUsage.input)}`);
    lines.push(`  output: ${String(ctx.tokenUsage.output)}`);
    if (ctx.tokenUsage.cacheRead !== undefined) {
      lines.push(`  cacheRead: ${String(ctx.tokenUsage.cacheRead)}`);
    }
    if (ctx.tokenUsage.cacheCreation !== undefined) {
      lines.push(`  cacheCreation: ${String(ctx.tokenUsage.cacheCreation)}`);
    }
  }
  lines.push('---');
  lines.push('');

  // Summary
  if (ctx.summary !== undefined) {
    lines.push('## Summary');
    lines.push('');
    lines.push(ctx.summary);
    lines.push('');
  }

  // Key decisions
  if (ctx.keyDecisions.length > 0) {
    lines.push('## Key Decisions');
    lines.push('');
    for (const decision of ctx.keyDecisions) {
      lines.push(`- ${decision}`);
    }
    lines.push('');
  }

  // Files modified
  if (ctx.filesModified.length > 0) {
    lines.push('## Files Modified');
    lines.push('');
    for (const file of ctx.filesModified) {
      lines.push(`- \`${file.path}\` — ${file.description}`);
    }
    lines.push('');
  }

  // Recent conversation
  if (ctx.recentConversation.length > 0) {
    lines.push('## Recent Conversation');
    lines.push('');
    for (const turn of ctx.recentConversation) {
      switch (turn.kind) {
        case 'user':
          lines.push(`### User\n${turn.text}\n`);
          break;
        case 'assistant': {
          const parts: string[] = ['### Assistant'];
          if (turn.thinking !== undefined) {
            parts.push(`> Thinking: ${turn.thinking}`);
          }
          if (turn.text !== undefined) {
            parts.push(turn.text);
          }
          lines.push(parts.join('\n') + '\n');
          break;
        }
        case 'tool-call':
          lines.push(
            `### Tool: ${turn.toolName}\n\`\`\`json\n${safeJsonStringify(turn.input, MAX_TOOL_INPUT_CHARS)}\n\`\`\`\n`,
          );
          break;
        case 'tool-result':
          lines.push(`### Tool Result: ${turn.toolName}\n${turn.summary}\n`);
          break;
      }
    }
  }

  // Pending work
  if (ctx.pendingWork.length > 0) {
    lines.push('## Pending Work');
    lines.push('');
    for (const item of ctx.pendingWork) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

function ensureBlocks(content: string | CCRawContentBlock[]): CCRawContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

function getTextFromContent(content: string | CCRawContentBlock[]): string {
  const blocks = ensureBlocks(content);
  return extractTextFromBlocks(blocks);
}

class ClaudeCodeParser implements SourceParser {
  readonly sourceId = 'claude-code';
  readonly label = 'Claude Code';

  async listSessions(): Promise<SourceSessionSummary[]> {
    const projectsDir = resolveClaudeConfigDir();
    const files = await discoverSessionFiles(projectsDir);
    const summaries: SourceSessionSummary[] = [];

    for (const filePath of files) {
      try {
        const st = await stat(filePath);
        const sessionId = filePath.replace(/\.jsonl$/, '').split('/').pop() ?? 'unknown';

        // Quick peek at the first few entries for metadata
        let firstUserText = '';
        let model = '';
        let cwd = '';
        let createdAt: string | undefined;

        let count = 0;
        for await (const entry of readEntries(filePath)) {
          if (count > 20) break;
          count++;

          if (entry.type === 'user' && firstUserText.length === 0 && entry.message !== undefined) {
            firstUserText = getTextFromContent(entry.message.content);
          }
          if (model.length === 0 && entry.type === 'assistant' && entry.message !== undefined) {
            const raw = entry.message as unknown as Record<string, unknown>;
            model = String(raw['model'] ?? '');
          }
          if (cwd.length === 0 && entry.cwd !== undefined) {
            cwd = entry.cwd;
          }
          if (createdAt === undefined && entry.timestamp !== undefined) {
            createdAt = entry.timestamp;
          }
        }

        const projectEncoded = filePath.split('/').slice(-2)[0] ?? '';
        const displayCwd = decodeProjectPath(projectEncoded);

        summaries.push({
          source: this.sourceId,
          sessionId,
          title: truncateText(firstUserText, 80) || undefined,
          workingDirectory: cwd || displayCwd,
          createdAt,
          updatedAt: st.mtime.toISOString(),
          model: model || undefined,
        });
      } catch {
        // Skip sessions we can't read
      }
    }

    // Most recent first
    summaries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return summaries;
  }

  async parseSession(sessionId: string): Promise<HandoffContext> {
    const projectsDir = resolveClaudeConfigDir();
    const files = await discoverSessionFiles(projectsDir);

    // Find the matching session file
    const filePath = files.find((f) => f.includes(sessionId));
    if (filePath === undefined) {
      throw new Error(`Claude Code session not found: ${sessionId}`);
    }

    // Collect all entries
    const entries: CCRawEntry[] = [];
    for await (const entry of readEntries(filePath)) {
      entries.push(entry);
    }

    return this.buildContext(sessionId, filePath, entries);
  }

  private buildContext(
    sessionId: string,
    _filePath: string,
    entries: CCRawEntry[],
  ): HandoffContext {
    // Filter to conversation entries
    const convEntries = entries.filter(isConversationEntry);

    // Extract metadata
    let firstUserText = '';
    let model = '';
    let cwd = '';
    let createdAt: string | undefined;

    for (const entry of entries) {
      if (entry.type === 'user' && firstUserText.length === 0 && entry.message !== undefined) {
        firstUserText = getTextFromContent(entry.message.content);
      }
      if (model.length === 0 && entry.type === 'assistant' && entry.message !== undefined) {
        const raw = entry.message as unknown as Record<string, unknown>;
        model = String(raw['model'] ?? '');
      }
      if (cwd.length === 0 && entry.cwd !== undefined) {
        cwd = entry.cwd;
      }
      if (createdAt === undefined && entry.timestamp !== undefined) {
        createdAt = entry.timestamp;
      }
      if (firstUserText.length > 0 && model.length > 0 && cwd.length > 0) break;
    }

    // Extract conversation turns
    const conversation: ConversationTurn[] = [];
    const allThinking: string[] = [];
    const toolIdToName = new Map<string, string>();

    for (const entry of convEntries.slice(-MAX_RECENT_TURNS * 2)) {
      if (entry.message === undefined) continue;

      if (entry.type === 'user') {
        const blocks = ensureBlocks(entry.message.content);

        // Tool results first
        const toolResults = extractToolResultsFromBlocks(blocks);
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            const toolName = toolIdToName.get(tr.tool_use_id) ?? 'tool';
            conversation.push({
              kind: 'tool-result',
              toolName,
              summary: safeStringify(tr.content, MAX_TOOL_INPUT_CHARS),
            });
          }
        }

        // User text
        const text = extractTextFromBlocks(blocks);
        if (text.length > 0) {
          conversation.push({ kind: 'user', text: truncateText(text, 500) });
        }
      } else {
        // assistant
        const blocks = ensureBlocks(entry.message.content);

        const thinking = extractThinkingFromBlocks(blocks);
        if (thinking.length > 0) {
          allThinking.push(thinking);
        }

        const toolCalls = extractToolCallsFromBlocks(blocks);
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            toolIdToName.set(tc.id, tc.name);
            conversation.push({
              kind: 'tool-call',
              toolName: tc.name,
              input: tc.input,
            });
          }
        }

        const text = extractTextFromBlocks(blocks);
        if (text.length > 0 || thinking.length > 0) {
          conversation.push({
            kind: 'assistant',
            text: text.length > 0 ? truncateText(text, 500) : undefined,
            thinking: thinking.length > 0 ? truncateText(thinking, MAX_THINKING_CHARS) : undefined,
          });
        }
      }
    }

    // Extract key decisions from thinking blocks
    const keyDecisions = extractKeyDecisions(allThinking);

    // Extract file changes
    const filesModified = extractFileChanges(entries, cwd || undefined);

    // Extract pending work
    const pendingWork = extractPendingWork(allThinking);

    // Aggregate token usage
    const tokenUsage = aggregateTokenUsage(entries);

    // Build context (without markdown)
    const ctx: Omit<HandoffContext, 'markdown'> = {
      source: this.sourceId,
      sourceSessionId: sessionId,
      model: model.length > 0 ? model : undefined,
      createdAt: createdAt !== undefined ? createdAt : undefined,
      workingDirectory: cwd.length > 0 ? cwd : undefined,
      tokenUsage: tokenUsage !== undefined ? tokenUsage : undefined,
      summary: truncateText(firstUserText, 200) || undefined,
      keyDecisions,
      filesModified,
      recentConversation: conversation.slice(-MAX_RECENT_TURNS),
      pendingWork,
    };

    return { ...ctx, markdown: generateHandoffMarkdown(ctx) };
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function extractKeyDecisions(thinkingBlocks: string[]): string[] {
  const decisions = new Set<string>();
  const decisionMarkers = [
    'decided to',
    'chose to',
    'opted for',
    'went with',
    'using',
    'instead of',
  ];

  for (const think of thinkingBlocks) {
    const lower = think.toLowerCase();
    for (const marker of decisionMarkers) {
      const idx = lower.indexOf(marker);
      if (idx >= 0) {
        // Extract the sentence containing this marker
        const snippet = think.slice(Math.max(0, idx - 30), idx + 150);
        decisions.add(truncateText(snippet.trim(), 200));
        break;
      }
    }
    if (decisions.size >= 10) break;
  }

  return [...decisions];
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function safeStringify(value: unknown, maxLen: number): string {
  try {
    const str = JSON.stringify(value);
    return truncateText(str, maxLen);
  } catch {
    return String(value).slice(0, maxLen);
  }
}

function safeJsonStringify(obj: Record<string, unknown>, maxLen: number): string {
  try {
    return truncateText(JSON.stringify(obj, null, 2), maxLen);
  } catch {
    return truncateText(JSON.stringify(obj), maxLen);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Singleton instance of the Claude Code parser. */
export const claudeCodeParser: SourceParser = new ClaudeCodeParser();
