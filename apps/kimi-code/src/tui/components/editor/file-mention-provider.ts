import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui';

const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);
const MAX_FALLBACK_SCAN = 2000;
const MAX_FALLBACK_SUGGESTIONS = 50;

interface FsMentionCandidate {
  readonly path: string;
  readonly isDirectory: boolean;
}

/**
 * Kimi wrapper around pi-tui's combined autocomplete provider.
 *
 * File / folder mention behavior uses pi-tui's fd-backed provider when fd is
 * available. While managed fd is downloading (or when it is unavailable), a
 * small filesystem fallback keeps basic `@` file and folder completion usable.
 * Ordinary path completion is still handled by pi-tui's readdir-backed path
 * completer. This wrapper also keeps Kimi-specific slash-command guards.
 */
export class FileMentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider;

  constructor(
    slashCommands: SlashCommand[],
    private readonly workDir: string,
    private readonly fdPath: string | null,
  ) {
    this.inner = new CombinedAutocompleteProvider(slashCommands, workDir, fdPath);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? '';
    const textBeforeCursor = currentLine.slice(0, cursorCol);

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

    const atPrefix = extractAtPrefix(textBeforeCursor);
    if (atPrefix !== null) {
      if (this.fdPath === null) {
        return getFsMentionSuggestions(this.workDir, atPrefix, options.signal);
      }
      try {
        return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
      } catch {
        // If fd fails to spawn unexpectedly, keep @ completion usable.
        return getFsMentionSuggestions(this.workDir, atPrefix, options.signal);
      }
    }

    try {
      return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
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
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

function extractAtPrefix(text: string): string | null {
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

function getFsMentionSuggestions(
  workDir: string,
  atPrefix: string,
  signal: AbortSignal,
): AutocompleteSuggestions | null {
  if (signal.aborted) return null;

  const query = atPrefix.slice(1);
  const candidates = collectFsMentionCandidates(workDir, signal);
  if (candidates.length === 0 || signal.aborted) return null;

  const ranked = rankFsMentionCandidates(candidates, query).slice(0, MAX_FALLBACK_SUGGESTIONS);
  if (ranked.length === 0) return null;

  return {
    prefix: atPrefix,
    items: ranked.map(toMentionItem),
  };
}

function collectFsMentionCandidates(workDir: string, signal: AbortSignal): FsMentionCandidate[] {
  const result: FsMentionCandidate[] = [];
  const stack = [''];

  while (stack.length > 0 && result.length < MAX_FALLBACK_SCAN) {
    if (signal.aborted) break;
    const relativeDir = stack.pop() ?? '';
    const absoluteDir = relativeDir.length === 0 ? workDir : join(workDir, relativeDir);
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (signal.aborted || result.length >= MAX_FALLBACK_SCAN) break;
      if (entry.name === '.git') continue;

      const relativePath = normalizePath(relativeDir.length === 0 ? entry.name : join(relativeDir, entry.name));
      const isSymlink = entry.isSymbolicLink();
      let isDirectory = entry.isDirectory();
      if (!isDirectory && isSymlink) {
        try {
          isDirectory = statSync(join(workDir, relativePath)).isDirectory();
        } catch {
          // Broken symlink or permission error — keep it as a file candidate.
        }
      }

      result.push({ path: relativePath, isDirectory });
      if (isDirectory && !isSymlink) {
        stack.push(relativePath);
      }
    }
  }

  return result;
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
    description: valuePath,
  };
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
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
