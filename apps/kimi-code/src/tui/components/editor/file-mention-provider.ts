import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  CombinedAutocompleteProvider,
  fuzzyMatch,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@moonshot-ai/pi-tui';

const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);
const MAX_FALLBACK_SCAN = 2000;
const MAX_FALLBACK_SUGGESTIONS = 50;

export interface SlashAutocompleteCommand extends SlashCommand {
  readonly aliases?: readonly string[];
}

interface FsMentionCandidate {
  readonly path: string;
  readonly absolutePath: string;
  readonly isDirectory: boolean;
}

/**
 * Kimi wrapper around pi-tui's combined autocomplete provider.
 *
 * File / folder mention behavior uses pi-tui's fd-backed provider when fd is
 * available and only the current working directory is involved. While managed fd
 * is downloading, when it is unavailable, or when the session has additional
 * roots, a small filesystem fallback keeps `@` file and folder completion usable
 * across every root. Ordinary path completion is still handled by pi-tui's
 * readdir-backed path completer. This wrapper also keeps Kimi-specific
 * slash-command guards.
 */
export class FileMentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider;
  private readonly additionalDirs: readonly string[];

  constructor(
    private readonly slashCommands: SlashAutocompleteCommand[],
    private readonly workDir: string,
    private readonly fdPath: string | null,
    additionalDirs: readonly string[] = [],
    private readonly getInputMode: () => 'prompt' | 'bash' = () => 'prompt',
  ) {
    this.additionalDirs = additionalDirs.map((dir) => normalizePath(resolve(workDir, dir)));
    // Build an expanded list that includes alias entries so that
    // inner's argument completion can find commands by alias too.
    const expanded: SlashAutocompleteCommand[] = [];
    for (const cmd of slashCommands) {
      expanded.push(cmd);
      for (const alias of cmd.aliases ?? []) {
        expanded.push({ ...cmd, name: alias });
      }
    }
    this.inner = new CombinedAutocompleteProvider(expanded, workDir, fdPath);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? '';
    const textBeforeCursor = currentLine.slice(0, cursorCol);

    // `@` file / folder mentions take priority over the slash-command guards
    // below. Without this, typing `@` inside a slash command's argument text
    // (e.g. `/goal Fix the @|checkout docs`) would be swallowed by
    // `shouldSuppressSlashArgumentCompletion` before the mention branch ever
    // runs, so the file list never opens.
    const atPrefix = extractAtPrefix(textBeforeCursor);
    if (atPrefix !== null) {
      if (this.fdPath === null || this.additionalDirs.length > 0) {
        return getFsMentionSuggestions(
          this.workDir,
          this.additionalDirs,
          atPrefix,
          options.signal,
        );
      }
      try {
        return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
      } catch {
        // If fd fails to spawn unexpectedly, keep @ completion usable.
        return getFsMentionSuggestions(
          this.workDir,
          this.additionalDirs,
          atPrefix,
          options.signal,
        );
      }
    }

    if (shouldSuppressLeadingWhitespaceSlashPath(textBeforeCursor, options.force)) {
      return null;
    }

    if (
      shouldSuppressSlashArgumentCompletion(
        textBeforeCursor,
        currentLine.slice(cursorCol),
        options.force,
      )
    ) {
      return null;
    }

    // Handle slash-command name completion ourselves so that aliases are
    // searchable and visible in the label.
    if (!options.force && textBeforeCursor.startsWith('/')) {
      const spaceIndex = textBeforeCursor.indexOf(' ');
      if (spaceIndex === -1) {
        const tokens = textBeforeCursor
          .slice(1)
          .trim()
          .split(/\s+/)
          .filter((t) => t.length > 0);

        type SlashMatch = {
          cmd: SlashAutocompleteCommand;
          score: number;
          viaAlias: boolean;
          label: string;
        };
        const matches: SlashMatch[] = [];

        for (const cmd of this.slashCommands) {
          const nameScore = scoreTokens(tokens, cmd.name);
          if (nameScore !== null) {
            matches.push({ cmd, score: nameScore, viaAlias: false, label: cmd.name });
            continue;
          }
          // Aliases only count when the primary name missed; the label then
          // lists them so the user can see why the command matched.
          const aliases = cmd.aliases ?? [];
          let bestAliasScore: number | null = null;
          for (const alias of aliases) {
            const aliasScore = scoreTokens(tokens, alias);
            if (aliasScore !== null && (bestAliasScore === null || aliasScore < bestAliasScore)) {
              bestAliasScore = aliasScore;
            }
          }
          if (bestAliasScore !== null) {
            matches.push({
              cmd,
              score: bestAliasScore,
              viaAlias: true,
              label: `${cmd.name} (${aliases.join(', ')})`,
            });
          }
        }

        // Primary-name matches outrank alias matches on score ties.
        matches.sort((a, b) => a.score - b.score || Number(a.viaAlias) - Number(b.viaAlias));

        if (matches.length === 0) return null;
        return {
          items: matches.map((m) => ({
            value: m.cmd.name,
            label: m.label,
            description: formatSlashCommandDescription(m.cmd),
          })),
          prefix: textBeforeCursor,
        };
      }
    }

    // In bash mode `/` is a path separator, not a slash command. Skip slash
    // command argument handling so an absolute path that happens to start with
    // a command name (e.g. `/add-dir/...`) completes inside the path instead of
    // returning the command's argument completions.
    if (this.getInputMode() !== 'bash') {
      const slashArgumentSuggestions = await getSlashArgumentSuggestions(this.slashCommands, textBeforeCursor);
      if (slashArgumentSuggestions !== null) {
        return slashArgumentSuggestions;
      }
    }

    try {
      const inner = await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
      if (inner === null || this.getInputMode() !== 'bash') {
        return inner;
      }
      // In bash mode `/` is a path separator; hide dot-prefixed entries to
      // match the `/add-dir` directory completer (registry.ts skips any name
      // starting with `.`). Ordinary prompt-mode path completion is left as-is.
      return { ...inner, items: inner.items.filter((item) => !isDotPrefixedEntry(item)) };
    } catch {
      return null;
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // In bash mode a leading `/` is a path, but pi-tui's applyCompletion
    // mistakes it for a slash command (prefix starts with `/`, nothing before
    // it, no second `/`) and prepends another `/`, producing e.g.
    // `//Applications/ ` with a trailing space that also blocks further
    // completion. Handle path completion ourselves so the value replaces the
    // prefix verbatim. `@` mentions keep pi-tui's behaviour.
    if (this.getInputMode() === 'bash' && prefix.startsWith('/')) {
      return applyPathCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

export function extractAtPrefix(text: string): string | null {
  let tokenStart = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? '')) {
      tokenStart = i + 1;
      break;
    }
  }
  if (text[tokenStart] !== '@') return null;
  return text.slice(tokenStart);
}

/**
 * Match the `/add-dir` directory completer, which skips every entry whose name
 * starts with `.` (see registry.ts). pi-tui's path completer sets `label` to
 * the entry basename, with a trailing `/` for directories.
 */
function isDotPrefixedEntry(item: AutocompleteItem): boolean {
  const name = item.label.endsWith('/') ? item.label.slice(0, -1) : item.label;
  return name.startsWith('.');
}

/**
 * Replace `prefix` with `item.value` verbatim, mirroring pi-tui's file-path
 * branch (no trailing space, so a completed directory can be extended with the
 * next `/`). Used in bash mode to avoid pi-tui's slash-command branch, which
 * would prepend an extra `/` to a bare leading `/` path. For a quoted
 * directory value (path contains spaces), the cursor stays inside the closing
 * quote so follow-up `/` completion keeps working.
 */
function applyPathCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItem,
  prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const currentLine = lines[cursorLine] ?? '';
  const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
  const afterCursor = currentLine.slice(cursorCol);
  const newLine = beforePrefix + item.value + afterCursor;
  const newLines = [...lines];
  newLines[cursorLine] = newLine;
  const isDirectory = item.label.endsWith('/');
  const hasTrailingQuote = item.value.endsWith('"');
  const cursorOffset =
    isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;
  return {
    lines: newLines,
    cursorLine,
    cursorCol: beforePrefix.length + cursorOffset,
  };
}

function getFsMentionSuggestions(
  workDir: string,
  additionalDirs: readonly string[],
  atPrefix: string,
  signal: AbortSignal,
): AutocompleteSuggestions | null {
  if (signal.aborted) return null;

  const query = atPrefix.slice(1);
  const candidates = collectFsMentionCandidates(workDir, additionalDirs, signal);
  if (candidates.length === 0 || signal.aborted) return null;

  const ranked = rankFsMentionCandidates(candidates, query).slice(0, MAX_FALLBACK_SUGGESTIONS);
  if (ranked.length === 0) return null;

  return {
    prefix: atPrefix,
    items: ranked.map(toMentionItem),
  };
}

function collectFsMentionCandidates(
  workDir: string,
  additionalDirs: readonly string[],
  signal: AbortSignal,
): FsMentionCandidate[] {
  const candidatesByAbsolutePath = new Map<string, FsMentionCandidate>();
  const roots = [
    { root: normalizePath(resolve(workDir)), isAdditionalDir: false },
    ...additionalDirs.map((dir) => ({
      root: normalizePath(resolve(workDir, dir)),
      isAdditionalDir: true,
    })),
  ];
  let scanned = 0;

  for (const { root, isAdditionalDir } of roots) {
    const stack = [''];

    while (stack.length > 0 && scanned < MAX_FALLBACK_SCAN) {
      if (signal.aborted) break;
      const relativeDir = stack.pop() ?? '';
      const absoluteDir = relativeDir.length === 0 ? root : join(root, relativeDir);
      let entries;
      try {
        entries = readdirSync(absoluteDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (signal.aborted || scanned >= MAX_FALLBACK_SCAN) break;
        if (entry.name === '.git') continue;

        const relativePath = normalizePath(
          relativeDir.length === 0 ? entry.name : join(relativeDir, entry.name),
        );
        const absolutePath = normalizePath(join(absoluteDir, entry.name));
        const isSymlink = entry.isSymbolicLink();
        let isDirectory = entry.isDirectory();
        if (!isDirectory && isSymlink) {
          try {
            isDirectory = statSync(absolutePath).isDirectory();
          } catch {
            // Broken symlink or permission error — keep it as a file candidate.
          }
        }

        scanned += 1;
        if (!candidatesByAbsolutePath.has(absolutePath)) {
          candidatesByAbsolutePath.set(absolutePath, {
            path: isAdditionalDir ? absolutePath : relativePath,
            absolutePath,
            isDirectory,
          });
        }
        if (isDirectory && !isSymlink) {
          stack.push(relativePath);
        }
      }
    }
  }

  return [...candidatesByAbsolutePath.values()];
}

function rankFsMentionCandidates(
  candidates: readonly FsMentionCandidate[],
  query: string,
): FsMentionCandidate[] {
  const lowerQuery = query.toLowerCase();
  const scored: Array<{ candidate: FsMentionCandidate; score: number }> = [];

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, lowerQuery);
    if (score > 0) scored.push({ candidate, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.candidate.isDirectory !== b.candidate.isDirectory) {
      return a.candidate.isDirectory ? -1 : 1;
    }
    return a.candidate.path.localeCompare(b.candidate.path);
  });

  return scored.map((entry) => entry.candidate);
}

function scoreCandidate(candidate: FsMentionCandidate, lowerQuery: string): number {
  if (lowerQuery.length === 0) {
    const depthPenalty = candidate.path.split('/').length - 1;
    return (candidate.isDirectory ? 120 : 100) - depthPenalty;
  }

  const lowerPath = candidate.path.toLowerCase();
  const lowerBase = basename(candidate.path).toLowerCase();
  let score = 0;
  if (lowerBase === lowerQuery) score = 100;
  else if (lowerBase.startsWith(lowerQuery)) score = 80;
  else if (lowerBase.includes(lowerQuery)) score = 50;
  else if (lowerPath.includes(lowerQuery)) score = 30;
  if (candidate.isDirectory && score > 0) score += 10;
  return score;
}

function toMentionItem(candidate: FsMentionCandidate): AutocompleteItem {
  const valuePath = candidate.isDirectory ? `${candidate.path}/` : candidate.path;
  const value = valuePath.includes(' ') ? `@"${valuePath}"` : `@${valuePath}`;
  const label = `${basename(candidate.path)}${candidate.isDirectory ? '/' : ''}`;
  return {
    value,
    label,
    description: candidate.absolutePath,
  };
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function getSlashArgumentSuggestions(
  slashCommands: readonly SlashAutocompleteCommand[],
  textBeforeCursor: string,
): Promise<AutocompleteSuggestions | null> {
  const parsed = parseSlashArgumentContext(textBeforeCursor, slashCommands);
  if (parsed === null) return null;

  const items = await parsed.command.getArgumentCompletions?.(parsed.argumentPrefix);
  if (items === undefined || items === null || items.length === 0) return null;

  return {
    prefix: parsed.argumentPrefix,
    items,
  };
}

function parseSlashArgumentContext(
  textBeforeCursor: string,
  slashCommands: readonly SlashAutocompleteCommand[],
): { command: SlashAutocompleteCommand; argumentPrefix: string } | null {
  const whitespaceMatch = textBeforeCursor.match(/^\/(\S+)\s+(\S*)$/);
  if (whitespaceMatch !== null) {
    const [, commandName = '', argumentPrefix = ''] = whitespaceMatch;
    const command = findSlashCommand(slashCommands, commandName);
    if (command === undefined) return null;
    if (!textBeforeCursor.endsWith(' ') && argumentPrefix.length === 0) return null;
    return { command, argumentPrefix };
  }

  const pathLikeMatch = textBeforeCursor.match(/^\/([^/\s]+)(\/.*)$/);
  const commandName = pathLikeMatch?.[1];
  const argumentPrefix = pathLikeMatch?.[2];
  if (commandName === undefined || argumentPrefix === undefined) return null;

  const command = findSlashCommand(slashCommands, commandName);
  if (command === undefined) return null;
  return { command, argumentPrefix };
}

function findSlashCommand(
  slashCommands: readonly SlashAutocompleteCommand[],
  commandName: string,
): SlashAutocompleteCommand | undefined {
  return slashCommands.find((cmd) => cmd.name === commandName || (cmd.aliases ?? []).includes(commandName));
}

function shouldSuppressLeadingWhitespaceSlashPath(
  textBeforeCursor: string,
  force: boolean | undefined,
): boolean {
  if (force === true) return false;
  if (textBeforeCursor.startsWith('/')) return false;
  return textBeforeCursor.trimStart().startsWith('/');
}

function shouldSuppressSlashArgumentCompletion(
  textBeforeCursor: string,
  textAfterCursor: string,
  force: boolean | undefined,
): boolean {
  if (force === true) return false;
  if (!textBeforeCursor.startsWith('/')) return false;
  if (!textBeforeCursor.includes(' ')) return false;
  return textAfterCursor.trimStart().length > 0;
}

/**
 * All tokens must fuzzy-match `text`; returns the summed score, or null when
 * any token misses. An empty token list matches everything with score 0.
 * Mirrors pi-tui fuzzyFilter's token semantics — keep in sync if it changes.
 */
function scoreTokens(tokens: readonly string[], text: string): number | null {
  let score = 0;
  for (const token of tokens) {
    const m = fuzzyMatch(token, text);
    if (!m.matches) return null;
    score += m.score;
  }
  return score;
}

/**
 * Mirrors CombinedAutocompleteProvider's description rendering so the
 * intercepted name completion keeps showing the argument hint.
 */
function formatSlashCommandDescription(cmd: SlashAutocompleteCommand): string | undefined {
  const desc = cmd.description ?? '';
  const full = cmd.argumentHint
    ? desc
      ? `${cmd.argumentHint} — ${desc}`
      : cmd.argumentHint
    : desc;
  return full || undefined;
}
