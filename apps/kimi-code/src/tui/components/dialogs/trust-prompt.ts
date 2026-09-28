import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import type { WorkspaceTrustInfo, WorkspaceTrustMcpServerInfo } from '@moonshot-ai/kimi-code-sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type TrustPromptChoice = 'trust' | 'distrust';

export interface TrustPromptOptions {
  readonly workDir: string;
  /** What trusting would activate; rendered before the workspace is trusted. */
  readonly info: WorkspaceTrustInfo;
  /** Esc resolves to 'distrust' as well. */
  readonly onSelect: (choice: TrustPromptChoice) => void;
}

interface TrustPromptOption {
  readonly value: TrustPromptChoice;
  readonly label: string;
  readonly description: string;
}

const MAX_MCP_SERVERS = 8;
const MAX_ADDITIONAL_DIRS = 6;
const MAX_NAME_LIST = 8;
const MAX_AGENTS_MD_PATHS = 4;

const OPTIONS: readonly TrustPromptOption[] = [
  {
    value: 'trust',
    label: 'Trust this folder',
    description: 'Load everything listed above. Remembered for this folder.',
  },
  {
    value: 'distrust',
    label: "Don't trust",
    description: 'Exit Kimi Code. Asked again next launch.',
  },
];

export class TrustPromptComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;

  constructor(private readonly opts: TrustPromptOptions) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onSelect('distrust');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(OPTIONS.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.opts.onSelect(OPTIONS[this.selectedIndex]!.value);
    }
  }

  render(width: number): string[] {
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const lines = [
      rule,
      currentTheme.boldFg('primary', ' Trust this folder?'),
      currentTheme.fg('textMuted', ' ↑↓ navigate · Enter select · Esc exit'),
      '',
      ...wrapTextWithAnsi(this.opts.workDir, Math.max(20, width - 2)).map(
        (line) => ` ${currentTheme.fg('textStrong', line)}`,
      ),
      '',
    ];

    lines.push(...this.renderDisclosure(width));
    lines.push('');

    for (let i = 0; i < OPTIONS.length; i += 1) {
      const option = OPTIONS[i]!;
      const selected = i === this.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const label = selected
        ? currentTheme.boldFg('primary', option.label)
        : currentTheme.fg('text', option.label);
      lines.push(currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) + label);
      for (const line of wrapTextWithAnsi(option.description, Math.max(20, width - 4))) {
        lines.push(`    ${currentTheme.fg('textMuted', line)}`);
      }
      lines.push('');
    }

    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderDisclosure(width: number): string[] {
    const {
      gatedMcpServers,
      gatedAdditionalDirs,
      disabledUserMcpServers,
      instructionSources,
      disclosureComplete,
    } = this.opts.info;
    const lines: string[] = [];
    const wrap = (text: string, indent: number): string[] =>
      wrapTextWithAnsi(text, Math.max(20, width - indent)).map(
        (line) => `${' '.repeat(indent)}${currentTheme.fg('warning', line)}`,
      );

    const hasContent =
      gatedMcpServers.length > 0 ||
      gatedAdditionalDirs.length > 0 ||
      disabledUserMcpServers.length > 0 ||
      instructionSources.agentsMdPaths.length > 0 ||
      instructionSources.skills.length > 0 ||
      instructionSources.agentProfiles.length > 0;

    if (!hasContent) {
      // The empty claim is only honest when discovery actually finished;
      // a timed-out or failed scan must say so instead of claiming nothing.
      const text = disclosureComplete
        ? 'No project-level config found here. Kimi Code will read, edit, and run files in this folder, subject to your approvals. Project config added later (MCP servers, extra directories, instructions) applies automatically once this folder is trusted.'
        : "Still scanning this folder's project config — disclosure may be incomplete.";
      return wrapTextWithAnsi(text, Math.max(20, width - 2)).map(
        (line) => ` ${currentTheme.fg('textMuted', line)}`,
      );
    }

    lines.push(` ${currentTheme.fg('text', 'Once trusted, this folder will:')}`);

    if (gatedMcpServers.length > 0) {
      lines.push('');
      lines.push(
        ...wrap(
          `Run ${gatedMcpServers.length} project MCP ${gatedMcpServers.length === 1 ? 'server' : 'servers'} — they start automatically, without asking:`,
          1,
        ),
      );
      for (const server of gatedMcpServers.slice(0, MAX_MCP_SERVERS)) {
        lines.push(...this.renderMcpServer(server, width));
      }
      if (gatedMcpServers.length > MAX_MCP_SERVERS) {
        lines.push(...wrap(`…and ${gatedMcpServers.length - MAX_MCP_SERVERS} more`, 3));
      }
    }

    if (disabledUserMcpServers.length > 0) {
      lines.push('');
      lines.push(
        ...wrap(
          `Turn off ${disabledUserMcpServers.length} user-level MCP ${disabledUserMcpServers.length === 1 ? 'server' : 'servers'} (disabled by project config):`,
          1,
        ),
      );
      for (const name of disabledUserMcpServers.slice(0, MAX_MCP_SERVERS)) {
        lines.push(...wrap(sanitizeForDisplay(name), 3));
      }
      if (disabledUserMcpServers.length > MAX_MCP_SERVERS) {
        lines.push(...wrap(`…and ${disabledUserMcpServers.length - MAX_MCP_SERVERS} more`, 3));
      }
    }

    if (gatedAdditionalDirs.length > 0) {
      lines.push('');
      lines.push(
        ...wrap(
          `Grant access to ${gatedAdditionalDirs.length} ${gatedAdditionalDirs.length === 1 ? 'directory' : 'directories'} outside this project (from .kimi-code/local.toml):`,
          1,
        ),
      );
      for (const dir of gatedAdditionalDirs.slice(0, MAX_ADDITIONAL_DIRS)) {
        const display =
          dir.path === dir.realPath ? dir.path : `${dir.path} → ${dir.realPath}`;
        lines.push(...wrap(sanitizeForDisplay(display), 3));
      }
      if (gatedAdditionalDirs.length > MAX_ADDITIONAL_DIRS) {
        lines.push(...wrap(`…and ${gatedAdditionalDirs.length - MAX_ADDITIONAL_DIRS} more`, 3));
      }
    }

    const instructionLines = this.renderInstructionSources(width);
    if (instructionLines.length > 0) {
      lines.push('');
      lines.push(
        ...wrap('Feed instructions to the agent — they steer behavior; approvals still apply:', 1),
      );
      lines.push(...instructionLines);
    }

    if (!disclosureComplete) {
      lines.push('');
      lines.push(
        ...wrap("Still scanning this folder's project config — disclosure may be incomplete.", 1),
      );
    }

    return lines;
  }

  private renderMcpServer(server: WorkspaceTrustMcpServerInfo, width: number): string[] {
    const lines: string[] = [];
    const wrap = (text: string, indent: number): string[] =>
      wrapTextWithAnsi(text, Math.max(20, width - indent)).map(
        (line) => `${' '.repeat(indent)}${currentTheme.fg('warning', line)}`,
      );
    lines.push(...wrap(formatMcpTarget(server), 3));
    const keys = formatMcpKeys(server);
    if (keys !== undefined) lines.push(...wrap(keys, 5));
    lines.push(...wrap(`from ${relativize(this.opts.workDir, server.origin)}`, 5));
    return lines;
  }

  private renderInstructionSources(width: number): string[] {
    const { agentsMdPaths, skills, agentProfiles } = this.opts.info.instructionSources;
    const wrap = (text: string, indent: number): string[] =>
      wrapTextWithAnsi(text, Math.max(20, width - indent)).map(
        (line) => `${' '.repeat(indent)}${currentTheme.fg('warning', line)}`,
      );
    const lines: string[] = [];
    if (agentsMdPaths.length > 0) {
      const shown = agentsMdPaths
        .slice(0, MAX_AGENTS_MD_PATHS)
        .map((path) => sanitizeForDisplay(relativize(this.opts.workDir, path)));
      const suffix = agentsMdPaths.length > MAX_AGENTS_MD_PATHS ? `, +${agentsMdPaths.length - MAX_AGENTS_MD_PATHS} more` : '';
      lines.push(...wrap(`AGENTS.md: ${shown.join(', ')}${suffix}`, 3));
    }
    if (skills.length > 0) {
      lines.push(...wrap(`skills: ${formatNameList(skills)}`, 3));
    }
    if (agentProfiles.length > 0) {
      lines.push(...wrap(`agent profiles: ${formatNameList(agentProfiles)}`, 3));
    }
    return lines;
  }
}

function formatMcpTarget(server: WorkspaceTrustMcpServerInfo): string {
  if (server.transport === 'stdio') {
    const args = server.args === undefined ? '' : ` args=${JSON.stringify(server.args)}`;
    const cwd = server.cwd === undefined ? '' : ` cwd=${server.cwd}`;
    return sanitizeForDisplay(`${server.name} (stdio): command=${server.command ?? ''}${args}${cwd}`);
  }
  return sanitizeForDisplay(`${server.name} (${server.transport}): url=${server.url ?? ''}`);
}

const MAX_KEY_LIST = 10;

function formatMcpKeys(server: WorkspaceTrustMcpServerInfo): string | undefined {
  const parts: string[] = [];
  if (server.envKeys !== undefined && server.envKeys.length > 0) {
    parts.push(`env keys: ${formatKeyList(server.envKeys)}`);
  }
  if (server.headerKeys !== undefined && server.headerKeys.length > 0) {
    parts.push(`header keys: ${formatKeyList(server.headerKeys)}`);
  }
  if (server.bearerTokenEnvVar !== undefined) {
    parts.push(`bearer token from env ${sanitizeForDisplay(server.bearerTokenEnvVar)}`);
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

// A crafted .mcp.json can declare thousands of keys; cap before joining so
// the prompt stays usable (same threat class as the control-char sanitizer).
function formatKeyList(keys: readonly string[]): string {
  const shown = keys.slice(0, MAX_KEY_LIST).map(sanitizeForDisplay);
  const suffix = keys.length > MAX_KEY_LIST ? `, +${keys.length - MAX_KEY_LIST} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

function formatNameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAME_LIST).map(sanitizeForDisplay);
  const suffix = names.length > MAX_NAME_LIST ? `, +${names.length - MAX_NAME_LIST} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

function relativize(workDir: string, path: string): string {
  const prefix = workDir.endsWith('/') ? workDir : `${workDir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Drops C0/C1 control characters (including ESC) from workspace-supplied text:
 * the trust prompt renders before the workspace is trusted, so a planted
 * `.mcp.json` must not inject terminal control sequences into it.
 */
function sanitizeForDisplay(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    result += char;
  }
  return result;
}
