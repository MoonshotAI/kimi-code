import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, type Dirent, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import {
  CombinedAutocompleteProvider,
  fuzzyMatch,
  type AutocompleteItem,
  type AutocompletePreviewContext,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@moonshot-ai/pi-tui';
import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';

import { findInlineSkillTokens } from '../../utils/inline-skill-tokens';
import { skillSourceLabel } from '../../commands/skills';
import { resolveCommandPath } from '../../../utils/process/resolve-command';

const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);
const MAX_FALLBACK_SCAN = 2000;
const MAX_FALLBACK_SUGGESTIONS = 50;

export interface SlashAutocompleteCommand extends SlashCommand {
  readonly aliases?: readonly string[];
  readonly skillPath?: string;
  readonly skillSource?: SkillSummary['source'];
  readonly isSkill?: boolean;
  readonly workspaceDir?: string;
}

interface FsMentionCandidate {
  readonly path: string;
  readonly absolutePath: string;
  readonly isDirectory: boolean;
  readonly root?: string;
  readonly ignored?: boolean;
}

export interface RemoteMentionCandidate {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink';
}

export type RemoteMentionSuggest = (
  query: string,
) => Promise<readonly RemoteMentionCandidate[] | undefined>;

export class FileMentionProvider implements AutocompleteProvider {
  readonly autocompleteDebounceMs = 80;
  private readonly inner: CombinedAutocompleteProvider;
  private readonly additionalDirs: readonly string[];
  private readonly workspaceLabels: ReadonlyMap<string, string>;

  constructor(
    private readonly slashCommands: SlashAutocompleteCommand[],
    private readonly workDir: string,
    private readonly fdPath: string | null,
    additionalDirs: readonly string[] = [],
    private readonly getInputMode: () => 'prompt' | 'bash' = () => 'prompt',
    private readonly skillCommandNames?: ReadonlySet<string>,
    private readonly remoteSuggest?: RemoteMentionSuggest,
    private readonly onSkillVariantSelected?: (selection: { commandName: string; path: string; start: number }) => void,
  ) {
    this.workspaceLabels = workspaceLabelsForCommands(slashCommands);
    this.additionalDirs = additionalDirs.map((dir) => resolveMentionDirectory(workDir, dir));
    const expanded: SlashAutocompleteCommand[] = [];
    for (const cmd of slashCommands) {
      expanded.push(cmd);
      for (const alias of cmd.aliases ?? []) {
        expanded.push({ ...cmd, name: alias });
      }
    }
    this.inner = new CombinedAutocompleteProvider(expanded, workDir, fdPath, this.additionalDirs, {
      includeGitignoredFiles: true,
    });
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? '';
    const textBeforeCursor = currentLine.slice(0, cursorCol);

    const atPrefix = extractAtPrefix(textBeforeCursor);
    if (atPrefix !== null) {
      if (this.remoteSuggest !== undefined) {
        return getRemoteMentionSuggestions(this.remoteSuggest, atPrefix, options.signal);
      }
      if (this.fdPath === null || !isExecutableFd(this.fdPath)) {
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
        return getFsMentionSuggestions(
          this.workDir,
          this.additionalDirs,
          atPrefix,
          options.signal,
        );
      }
    }

    const inlineSkillPrefix = extractInlineSkillPrefix(textBeforeCursor, cursorLine);

    if (
      inlineSkillPrefix === null &&
      shouldSuppressLeadingWhitespaceSlashPath(textBeforeCursor, options.force)
    ) {
      return null;
    }

    if (
      cursorLine > 0 &&
      textBeforeCursor.trim() === '/' &&
      this.getInputMode() !== 'bash' &&
      options.force !== true
    ) {
      return this.getInlineSkillSuggestions('/');
    }

    if (
      inlineSkillPrefix === null &&
      shouldSuppressSlashArgumentCompletion(
        textBeforeCursor,
        currentLine.slice(cursorCol),
        options.force,
      )
    ) {
      return null;
    }

    if (!options.force && cursorLine === 0 && textBeforeCursor.startsWith('/')) {
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

        matches.sort((a, b) =>
          Number(a.cmd.isSkill === true) - Number(b.cmd.isSkill === true) ||
          a.score - b.score ||
          Number(a.viaAlias) - Number(b.viaAlias),
        );

        if (matches.length === 0) return null;
        return {
          items: matches.map((m) => ({
            value: m.cmd.name,
            label: m.label,
            description: formatSlashCommandDescription(m.cmd),
            data: {
              group: m.cmd.isSkill === true ? 'skill' : undefined,
              skillPath: m.cmd.skillPath,
              workspaceLabel: m.cmd.workspaceDir === undefined
                ? skillSourceLabel(m.cmd.skillSource)
                : this.workspaceLabels.get(m.cmd.workspaceDir) ?? m.cmd.workspaceDir,
            },
          })),
          prefix: textBeforeCursor,
        };
      }
    }

    if (this.getInputMode() !== 'bash') {
      const slashArgumentSuggestions = await getSlashArgumentSuggestions(this.slashCommands, textBeforeCursor);
      if (slashArgumentSuggestions !== null) {
        return slashArgumentSuggestions;
      }
    }

    if (
      inlineSkillPrefix !== null &&
      this.getInputMode() !== 'bash' &&
      options.force !== true
    ) {
      return this.getInlineSkillSuggestions(inlineSkillPrefix);
    }

    try {
      const inner = await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
      if (inner === null || this.getInputMode() !== 'bash') {
        return inner;
      }
      return { ...inner, items: inner.items.filter((item) => !isDotPrefixedEntry(item)) };
    } catch {
      return null;
    }
  }

  private getInlineSkillSuggestions(prefix: string): AutocompleteSuggestions | null {
    if (this.skillCommandNames === undefined || this.skillCommandNames.size === 0) return null;
    const names = this.skillCommandNames;
    const tokens = prefix
      .slice(1)
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    const matches: Array<{ cmd: SlashAutocompleteCommand; score: number }> = [];
    for (const cmd of this.slashCommands) {
      if (!names.has(cmd.name)) continue;
      const score = scoreTokens(tokens, cmd.name);
      if (score !== null) {
        matches.push({ cmd, score });
      }
    }
    matches.sort((a, b) => a.score - b.score);

    if (matches.length === 0) return null;
    return {
      items: matches.map((m) => ({
        value: m.cmd.name,
        label: m.cmd.name,
        description: formatSlashCommandDescription(m.cmd),
        data: {
          group: m.cmd.isSkill === true ? 'skill' : undefined,
          inlineSkill: true,
          skillPath: m.cmd.skillPath,
          workspaceLabel: m.cmd.workspaceDir === undefined
            ? skillSourceLabel(m.cmd.skillSource)
            : this.workspaceLabels.get(m.cmd.workspaceDir) ?? m.cmd.workspaceDir,
        },
      })),
      prefix,
    };
  }

  getAutocompletePreview(context: AutocompletePreviewContext): AutocompleteSuggestions | null {
    const { previous } = context;
    if (context.cursorLine !== previous.cursorLine || context.lines.length !== previous.lines.length) {
      return null;
    }
    const previousLine = previous.lines[previous.cursorLine] ?? '';
    const currentLine = context.lines[context.cursorLine] ?? '';
    const previousPrefix = extractAtPrefix(previousLine.slice(0, previous.cursorCol));
    const currentPrefix = extractAtPrefix(currentLine.slice(0, context.cursorCol));
    if (
      previousPrefix === null ||
      currentPrefix === null ||
      previous.suggestions.prefix !== previousPrefix ||
      currentPrefix.length <= previousPrefix.length ||
      !currentPrefix.startsWith(previousPrefix)
    ) {
      return null;
    }
    const appended = currentPrefix.slice(previousPrefix.length);
    if (appended.includes('/') || appended.includes('\\')) return null;
    if (context.cursorCol !== previous.cursorCol + appended.length) return null;
    const expectedLine = `${previousLine.slice(0, previous.cursorCol)}${appended}${previousLine.slice(previous.cursorCol)}`;
    if (currentLine !== expectedLine) return null;
    for (let index = 0; index < context.lines.length; index += 1) {
      if (index !== context.cursorLine && context.lines[index] !== previous.lines[index]) return null;
    }

    const query = currentPrefix.startsWith('@"') ? currentPrefix.slice(2) : currentPrefix.slice(1);
    const items = previous.suggestions.items.filter((item) => {
      const path = item.value.startsWith('@"') && item.value.endsWith('"')
        ? item.value.slice(2, -1)
        : item.value.slice(1);
      return fuzzyMatch(query, path).matches;
    });
    return { prefix: currentPrefix, items };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const skillPath = item.data?.['skillPath'];
    if (typeof skillPath === 'string' && skillPath.length > 0) {
      const lineStart = lines.slice(0, cursorLine).reduce((start, line) => start + line.length + 1, 0);
      this.onSkillVariantSelected?.({
        commandName: item.value,
        path: skillPath,
        start: lineStart + cursorCol - prefix.length,
      });
    }
    if (
      item.data?.['inlineSkill'] === true &&
      this.getInputMode() !== 'bash' &&
      prefix.startsWith('/')
    ) {
      const currentLine = lines[cursorLine] ?? '';
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      if (extractInlineSkillPrefix(textBeforeCursor, cursorLine) === prefix) {
        const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
        const afterCursor = currentLine.slice(cursorCol);
        const newLines = [...lines];
        newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
        return {
          lines: newLines,
          cursorLine,
          cursorCol: beforePrefix.length + item.value.length + 2,
        };
      }
    }
    if (this.getInputMode() === 'bash' && prefix.startsWith('/')) {
      return applyPathCompletion(lines, cursorLine, cursorCol, item, prefix);
    }
    if (prefix.startsWith('@')) {
      const currentLine = lines[cursorLine] ?? '';
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const livePrefix = extractAtPrefix(textBeforeCursor);
      if (livePrefix === null) {
        return { lines, cursorLine, cursorCol };
      }
      const applyItem =
        livePrefix.startsWith('@"') && item.value.startsWith('@') && !item.value.startsWith('@"')
          ? { ...item, value: `@"${item.value.slice(1)}"` }
          : item;
      return this.inner.applyCompletion(lines, cursorLine, cursorCol, applyItem, livePrefix);
    }
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

export function extractInlineSkillPrefix(text: string, cursorLine: number = 0): string | null {
  if (cursorLine > 0) {
    const trimmedStart = text.trimStart();
    const match = /^\/[^\s/]*$/.exec(trimmedStart);
    if (match !== null) return match[0];
  }
  const tokens = findInlineSkillTokens(text, {
    isKnownSkill: () => true,
    allowEmpty: true,
  });
  const token = tokens.findLast((t) => t.end === text.length);
  return token === undefined ? null : text.slice(token.start);
}

export function extractAtPrefix(text: string): string | null {
  const quotedPrefix = extractQuotedAtPrefix(text);
  if (quotedPrefix !== null) return quotedPrefix;

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

function extractQuotedAtPrefix(text: string): string | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  if (!inQuotes || quoteStart <= 0 || text[quoteStart - 1] !== '@') return null;
  const atIndex = quoteStart - 1;
  if (atIndex > 0 && !PATH_DELIMITERS.has(text[atIndex - 1] ?? '')) return null;
  return text.slice(atIndex);
}

function isExecutableFd(fdPath: string): boolean {
  if (!fdPath.includes('/') && !fdPath.includes('\\')) {
    return true;
  }
  try {
    accessSync(fdPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function workspaceLabelsForCommands(
  commands: readonly SlashAutocompleteCommand[],
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const dirs = new Set<string>();
  for (const command of commands) {
    if (command.workspaceDir !== undefined) dirs.add(command.workspaceDir);
  }
  for (const dir of dirs) {
    const label = basename(dir) || dir;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const command of commands) {
    if (command.workspaceDir === undefined) continue;
    const label = basename(command.workspaceDir) || command.workspaceDir;
    labels.set(command.workspaceDir, counts.get(label)! > 1 ? command.workspaceDir : label);
  }
  return labels;
}

function isDotPrefixedEntry(item: AutocompleteItem): boolean {
  const name = item.label.endsWith('/') ? item.label.slice(0, -1) : item.label;
  return name.startsWith('.');
}

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

async function getRemoteMentionSuggestions(
  suggest: RemoteMentionSuggest,
  atPrefix: string,
  signal: AbortSignal,
): Promise<AutocompleteSuggestions | null> {
  if (signal.aborted) return null;
  const isQuotedPrefix = atPrefix.startsWith('@"');
  const query = isQuotedPrefix ? atPrefix.slice(2) : atPrefix.slice(1);
  try {
    const candidates = await suggest(query);
    if (candidates === undefined || candidates.length === 0 || signal.aborted) return null;
    return {
      prefix: atPrefix,
      items: candidates.map((candidate) =>
        toMentionItem(
          {
            path: candidate.path,
            absolutePath: candidate.path,
            isDirectory: candidate.kind === 'directory',
          },
          isQuotedPrefix,
        ),
      ),
    };
  } catch {
    return null;
  }
}

function getFsMentionSuggestions(
  workDir: string,
  additionalDirs: readonly string[],
  atPrefix: string,
  signal: AbortSignal,
): AutocompleteSuggestions | null {
  if (signal.aborted) return null;

  const isQuotedPrefix = atPrefix.startsWith('@"');
  const query = isQuotedPrefix ? atPrefix.slice(2) : atPrefix.slice(1);
  const collected = collectFsMentionCandidates(workDir, additionalDirs, signal);
  if (collected.length === 0 || signal.aborted) return null;
  const candidates = markGitignoredCandidates(collected, signal);
  if (signal.aborted) return null;

  const ranked = rankFsMentionCandidates(candidates, query).slice(0, MAX_FALLBACK_SUGGESTIONS);
  if (ranked.length === 0) return null;

  return {
    prefix: atPrefix,
    items: ranked.map((candidate) => toMentionItem(candidate, isQuotedPrefix)),
  };
}

function collectFsMentionCandidates(
  workDir: string,
  additionalDirs: readonly string[],
  signal: AbortSignal,
): FsMentionCandidate[] {
  const candidatesByAbsolutePath = new Map<string, FsMentionCandidate>();
  const workRoot = normalizePath(resolve(workDir));
  const rootsByPath = new Map([[workRoot, { root: workRoot, isAdditionalDir: false }]]);
  for (const dir of additionalDirs) {
    const root = normalizePath(resolve(workDir, dir));
    if (!rootsByPath.has(root)) {
      rootsByPath.set(root, { root, isAdditionalDir: true });
    }
  }
  const pending = [...rootsByPath.values()].map(({ root, isAdditionalDir }) => ({
    root,
    isAdditionalDir,
    stack: [''],
    relativeDir: '',
    entries: [] as Dirent[],
    entryIndex: 0,
  }));
  let scanned = 0;

  while (
    !signal.aborted &&
    scanned < MAX_FALLBACK_SCAN &&
    pending.some((state) => state.stack.length > 0 || state.entryIndex < state.entries.length)
  ) {
    for (const state of pending) {
      if (signal.aborted || scanned >= MAX_FALLBACK_SCAN) break;
      if (state.entryIndex >= state.entries.length) {
        if (state.stack.length === 0) continue;
        state.relativeDir = state.stack.pop() ?? '';
        const absoluteDir =
          state.relativeDir.length === 0 ? state.root : join(state.root, state.relativeDir);
        try {
          state.entries = readdirSync(absoluteDir, { withFileTypes: true });
        } catch {
          state.entries = [];
        }
        state.entryIndex = 0;
      }

      const entry = state.entries[state.entryIndex];
      state.entryIndex += 1;
      if (entry === undefined || entry.name === '.git') continue;

      const relativePath = normalizePath(
        state.relativeDir.length === 0 ? entry.name : join(state.relativeDir, entry.name),
      );
      const absoluteDir =
        state.relativeDir.length === 0 ? state.root : join(state.root, state.relativeDir);
      const absolutePath = normalizePath(join(absoluteDir, entry.name));
      const isSymlink = entry.isSymbolicLink();
      let isDirectory = entry.isDirectory();
      if (!isDirectory && isSymlink) {
        try {
          isDirectory = statSync(absolutePath).isDirectory();
        } catch {}
      }

      scanned += 1;
      if (!candidatesByAbsolutePath.has(absolutePath) || !state.isAdditionalDir) {
        candidatesByAbsolutePath.set(absolutePath, {
          path: state.isAdditionalDir ? absolutePath : relativePath,
          absolutePath,
          isDirectory,
          root: state.root,
          ignored: false,
        });
      }
      if (isDirectory && !isSymlink) {
        state.stack.push(relativePath);
      }
    }
  }

  return [...candidatesByAbsolutePath.values()];
}

function markGitignoredCandidates(
  candidates: readonly FsMentionCandidate[],
  signal: AbortSignal,
): FsMentionCandidate[] {
  const pathsByRoot = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.root === undefined) continue;
    const path = normalizePath(relative(candidate.root, candidate.absolutePath));
    if (path === '' || path === '..' || path.startsWith('../')) continue;
    const paths = pathsByRoot.get(candidate.root) ?? [];
    paths.push(path);
    pathsByRoot.set(candidate.root, paths);
  }

  const ignoredPaths = new Set<string>();
  for (const [root, paths] of pathsByRoot) {
    if (signal.aborted) break;
    const git = resolveCommandPath('git', root);
    if (git === undefined) continue;
    const result = spawnSync(git, ['check-ignore', '--no-index', '--stdin', '-z'], {
      cwd: root,
      input: `${paths.join('\0')}\0`,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 1000,
    });
    if (result.status !== 0) continue;
    for (const path of result.stdout.split('\0')) {
      if (path !== '') ignoredPaths.add(normalizePath(join(root, path)));
    }
  }
  if (ignoredPaths.size === 0) return [...candidates];
  return candidates.map((candidate) =>
    ignoredPaths.has(candidate.absolutePath) ? { ...candidate, ignored: true } : candidate,
  );
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
    if (a.candidate.ignored !== b.candidate.ignored) {
      return Number(a.candidate.ignored === true) - Number(b.candidate.ignored === true);
    }
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

function toMentionItem(candidate: FsMentionCandidate, isQuotedPrefix: boolean): AutocompleteItem {
  const valuePath = candidate.isDirectory ? `${candidate.path}/` : candidate.path;
  const value =
    isQuotedPrefix || valuePath.includes(' ') ? `@"${valuePath}"` : `@${valuePath}`;
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

export function resolveMentionDirectory(workDir: string, dir: string): string {
  if (dir === '~') return normalizePath(homedir());
  if (dir.startsWith('~/')) return normalizePath(join(homedir(), dir.slice(2)));
  return normalizePath(resolve(workDir, dir));
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

function scoreTokens(tokens: readonly string[], text: string): number | null {
  let score = 0;
  for (const token of tokens) {
    const m = fuzzyMatch(token, text);
    if (!m.matches) return null;
    score += m.score;
  }
  return score;
}

function formatSlashCommandDescription(cmd: SlashAutocompleteCommand): string | undefined {
  const desc = cmd.description ?? '';
  const full = cmd.argumentHint
    ? desc
      ? `${cmd.argumentHint} — ${desc}`
      : cmd.argumentHint
    : desc;
  return full || undefined;
}
