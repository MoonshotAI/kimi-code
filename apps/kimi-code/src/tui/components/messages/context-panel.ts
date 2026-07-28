/**
 * ContextPanelComponent — renders the `/context` report: a Claude Code-style
 * context-usage panel with a block-grid visualization, model + context-window
 * summary, and the estimated per-category token cost of the context
 * (system prompt, tool schemas, MCP tools, memory files, skills, messages),
 * with per-server / per-file / per-skill token detail under each section.
 */

import type {
  ContextBreakdownData,
  McpServerInfo,
} from '@moonshot-ai/kimi-code-sdk';

import { formatTokenCount, ratioSeverity, safeUsageRatio } from '#/utils/usage/usage-format';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

const BLOCK_FILLED = '⛁';
const BLOCK_EMPTY = '⛶';
const GRID_COLS = 10;
const GRID_ROWS = 4;
const GRID_BLOCKS = GRID_COLS * GRID_ROWS;

export interface ContextReportOptions {
  readonly model: string;
  readonly breakdown?: ContextBreakdownData;
  readonly mcpServers?: readonly McpServerInfo[];
  readonly error?: string;
}

function severityColor(sev: 'ok' | 'warn' | 'danger'): ColorToken {
  return sev === 'danger' ? 'error' : sev === 'warn' ? 'warning' : 'success';
}

function renderBlockGrid(used: number, max: number): string[] {
  const emptyCell = currentTheme.fg('textDim', BLOCK_EMPTY);
  if (max <= 0) {
    return Array.from({ length: GRID_ROWS }, () => emptyCell.repeat(GRID_COLS));
  }
  const ratio = safeUsageRatio(used / max);
  const usedBlocks = Math.round(ratio * GRID_BLOCKS);
  const filledCell = currentTheme.fg(severityColor(ratioSeverity(ratio)), BLOCK_FILLED);
  const lines: string[] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < GRID_COLS; col += 1) {
      const index = row * GRID_COLS + col;
      cells.push(index < usedBlocks ? filledCell : emptyCell);
    }
    lines.push(cells.join(' '));
  }
  return lines;
}

/** Percentage of the context window with one decimal ("1.2"), like Claude Code. */
function percentOf(tokens: number, max: number): string {
  return ((tokens / max) * 100).toFixed(1);
}

function categoryLine(icon: string, color: ColorToken, label: string, value: string): string {
  return `  ${currentTheme.fg(color, icon)} ${currentTheme.boldFg('text', label)}: ${value}`;
}

/** "2.4k tokens (1.2%)" — percent of the context window, or plain tokens when unknown. */
function tokenValue(tokens: number, max: number): string {
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const base = `${currentTheme.fg('text', formatTokenCount(tokens))} ${muted('tokens')}`;
  return max > 0 ? `${base} ${muted(`(${percentOf(tokens, max)}%)`)}` : base;
}

/** "~555 tokens" for detail lines, where the value is always an estimate. */
function estimateValue(tokens: number): string {
  return currentTheme.fg('textDim', `~${formatTokenCount(tokens)} tokens`);
}

function buildMcpServerLines(
  servers: readonly McpServerInfo[] | undefined,
  breakdown: ContextBreakdownData,
): string[] {
  if (servers === undefined || servers.length === 0) return [];
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const tokensByServer = new Map(breakdown.mcpServers.map((server) => [server.name, server.tokens]));
  const lines: string[] = ['', currentTheme.boldFg('primary', `MCP servers · /mcp`)];
  const sorted = servers.toSorted((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < sorted.length; i += 1) {
    const server = sorted[i]!;
    const isLast = i === sorted.length - 1;
    const branch = isLast ? '└' : '├';
    const statusBadge = server.status === 'connected' ? currentTheme.fg('success', '●') : muted('○');
    const tokens = tokensByServer.get(server.name);
    lines.push(
      `  ${branch} ${statusBadge} ${value(server.name)} ${muted(
        `(${server.toolCount} tool${server.toolCount === 1 ? '' : 's'})`,
      )}${tokens === undefined ? '' : ` ${estimateValue(tokens)}`}`,
    );
  }
  return lines;
}

function buildMemoryFileLines(breakdown: ContextBreakdownData): string[] {
  const files = breakdown.memoryFileEntries;
  if (files.length === 0) return [];
  const value = (text: string) => currentTheme.fg('text', text);
  const lines: string[] = ['', currentTheme.boldFg('roleUser', `Memory files`)];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const branch = i === files.length - 1 ? '└' : '├';
    lines.push(`  ${branch} ${value(file.path)} ${estimateValue(file.tokens)}`);
  }
  return lines;
}

function buildSkillLines(breakdown: ContextBreakdownData): string[] {
  const skills = breakdown.skillEntries;
  if (skills.length === 0) return [];
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const lines: string[] = ['', currentTheme.boldFg('shellMode', `Skills · /skills`)];
  const sorted = skills.toSorted((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < sorted.length; i += 1) {
    const skill = sorted[i]!;
    const branch = i === sorted.length - 1 ? '└' : '├';
    lines.push(
      `  ${branch} ${value(skill.name)} ${muted(`[${skill.source}]`)} ${estimateValue(skill.tokens)}`,
    );
  }
  return lines;
}

export function buildContextReportLines(options: ContextReportOptions): string[] {
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const errorStyle = (text: string) => currentTheme.fg('error', text);

  const lines: string[] = [accent('Context Usage')];

  if (options.error !== undefined || options.breakdown === undefined) {
    lines.push(errorStyle(`  ${options.error ?? 'Context breakdown unavailable.'}`));
    return lines;
  }
  const breakdown = options.breakdown;

  const modelName = options.model.length > 0 ? options.model : muted('No model selected');
  const grid = renderBlockGrid(breakdown.usedTokens, breakdown.maxContextTokens);
  const hasWindow = breakdown.maxContextTokens > 0;
  const tokenLine = hasWindow
    ? `${value(formatTokenCount(breakdown.usedTokens))}/${value(
        formatTokenCount(breakdown.maxContextTokens),
      )} ${muted('tokens')} ${muted(`(${percentOf(breakdown.usedTokens, breakdown.maxContextTokens)}%)`)}`
    : `${value(formatTokenCount(breakdown.usedTokens))} ${muted('tokens')}`;

  // Right-align the summary text next to the first two grid rows.
  lines.push(`  ${grid[0]}   ${modelName}`);
  lines.push(`  ${grid[1]}   ${tokenLine}`);
  lines.push(`  ${grid[2]}`);
  lines.push(`  ${grid[3]}`);

  lines.push('');
  lines.push(muted('  Estimated usage by category'));

  const max = breakdown.maxContextTokens;
  const freeTokens = hasWindow ? Math.max(0, max - breakdown.usedTokens) : 0;

  lines.push(categoryLine('⛁', 'warning', 'System prompt', tokenValue(breakdown.systemPrompt, max)));
  lines.push(categoryLine('⛁', 'accent', 'System tools', tokenValue(breakdown.systemTools, max)));

  const mcpToolCount = options.mcpServers?.reduce((sum, server) => sum + server.toolCount, 0) ?? 0;
  const mcpSuffix =
    mcpToolCount > 0
      ? muted(` · ${mcpToolCount} tool${mcpToolCount === 1 ? '' : 's'}`)
      : '';
  lines.push(
    categoryLine('⛁', 'primary', 'MCP tools', tokenValue(breakdown.mcpTools, max) + mcpSuffix),
  );

  lines.push(categoryLine('⛁', 'roleUser', 'Memory files', tokenValue(breakdown.memoryFiles, max)));
  lines.push(categoryLine('⛁', 'shellMode', 'Skills', tokenValue(breakdown.skills, max)));
  lines.push(categoryLine('⛁', 'text', 'Messages', tokenValue(breakdown.messages, max)));
  lines.push(categoryLine('⛶', 'textDim', 'Free space', hasWindow ? tokenValue(freeTokens, max) : muted('unknown')));

  lines.push(...buildMcpServerLines(options.mcpServers, breakdown));
  lines.push(...buildMemoryFileLines(breakdown));
  lines.push(...buildSkillLines(breakdown));

  return lines;
}
