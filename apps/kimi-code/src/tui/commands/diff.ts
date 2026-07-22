import { relative as makeRelative, resolve as resolvePath } from 'node:path';

import {
  isInsideGitRepo,
  listChangedFiles,
  runGitDiffForFile,
  runGitNumstat,
  runUntrackedNumstat,
} from '#/utils/git/git-diff';
import {
  computeDiffLines,
  makeDiffStyles,
  renderDiffLinesClustered,
} from '../components/media/diff-preview';
import {
  DiffFileSelectorComponent,
  type DiffSelectorFile,
  type DiffSource,
} from '../components/dialogs/diff-file-selector';
import { DiffViewerComponent } from '../components/dialogs/diff-viewer';
import { buildDiffPanelLines, DiffPanelComponent } from '../components/messages/diff-panel';
import { currentTheme } from '../theme';
import {
  collectSessionEditsByTurn,
  type SessionEditWithTurn,
} from '../utils/session-edits';
import { groupTurns, type TranscriptTurn } from '../utils/transcript-window';
import { formatErrorMessage } from '../utils/event-payload';
import type { TranscriptEntry } from '../types';
import type { SlashCommandHost } from './dispatch';

export async function handleDiffCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const workDir = host.state.appState.workDir;

  try {
    const { sources, sessionEdits } = await buildDiffSources(
      workDir,
      host.state.transcriptEntries,
      host.state.transcriptContainer.children,
    );

    if (sources.every((s) => s.files.length === 0)) {
      host.showStatus('No changed files.');
      return;
    }

    const singleSourceWithSingleFile = sources.length === 1 && sources[0]!.files.length === 1;
    if (singleSourceWithSingleFile) {
      await showDiffForChoice(host, workDir, sessionEdits, sources[0]!.files[0]!);
      return;
    }

    const mountSelector = (initialSourceIndex = 0, initialSelectedIndex = 0): void => {
      const selector = new DiffFileSelectorComponent({
        sources,
        initialSourceIndex,
        initialSelectedIndex,
        onSelect: (choice) => {
          void showDiffViewer(host, workDir, sessionEdits, choice, () => {
            mountSelector(selector.getActiveSourceIndex(), selector.getSelectedIndex());
          });
        },
        onCancel: () => {
          host.restoreEditor();
        },
      });
      host.mountEditorReplacement(selector);
    };
    mountSelector();
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

interface DiffSourcesResult {
  readonly sources: DiffSource[];
  readonly sessionEdits: readonly SessionEditWithTurn[];
}

async function buildDiffSources(
  workDir: string,
  entries: readonly TranscriptEntry[],
  components: readonly unknown[],
): Promise<DiffSourcesResult> {
  const sessionEdits = collectSessionEditsByTurn(entries, components).map((edit) => ({
    ...edit,
    path: makeRelative(workDir, resolvePath(workDir, edit.path)),
  }));

  const sources: DiffSource[] = [];

  // Git working-tree changes are shown when inside a git repo; otherwise only
  // session edits are available.
  const inGitRepo = isInsideGitRepo(workDir);
  const gitFiles = inGitRepo ? await listChangedFiles(workDir) : [];
  const gitNumstat = inGitRepo ? await runGitNumstat(workDir) : new Map();

  // Current source = all git changes, including files also edited by session tools.
  const currentFiles = await Promise.all(
    gitFiles
      .map((f): DiffSelectorFile | undefined => {
        const status = normalizeGitStatus(f.status);
        if (status === undefined) return undefined;
        const relativePath = makeRelative(workDir, resolvePath(workDir, f.path));
        const numstat = status === 'untracked' ? undefined : gitNumstat.get(relativePath);
        return {
          path: relativePath,
          status,
          source: 'git',
          additions: numstat?.additions,
          deletions: numstat?.deletions,
        };
      })
      .filter((f): f is DiffSelectorFile => f !== undefined)
      .map(async (f) => {
        if (f.status === 'untracked') {
          const stat = await runUntrackedNumstat(workDir, f.path);
          return { ...f, additions: stat.additions, deletions: stat.deletions };
        }
        return f;
      }),
  );
  sources.push({ label: 'Current', files: currentFiles });

  // Turn sources from session edits.
  const turns = groupTurns(entries);
  const turnIndexById = new Map<string, number>();
  for (const [index, turn] of turns.entries()) {
    if (turn.turnId !== undefined) {
      turnIndexById.set(turn.turnId, index + 1);
    }
  }

  const editsByTurn = new Map<string | undefined, SessionEditWithTurn[]>();
  for (const edit of sessionEdits) {
    const list = editsByTurn.get(edit.turnId) ?? [];
    list.push(edit);
    editsByTurn.set(edit.turnId, list);
  }

  const turnEntries: Array<{ readonly turnId: string | undefined; readonly source: DiffSource }> =
    [];
  for (const [turnId, edits] of editsByTurn) {
    const files = buildFilesFromSessionEdits(edits);
    if (files.length === 0) continue;
    const turnNumber = turnId !== undefined ? turnIndexById.get(turnId) : undefined;
    const label = turnNumber !== undefined ? `T${String(turnNumber)}` : '-';
    const subtitle = buildTurnSubtitle(turnNumber, turnId, turns);
    turnEntries.push({ turnId, source: { label, subtitle, files } });
  }

  // Sort turn sources newest first (highest turn number first).
  turnEntries.sort((a, b) => {
    const ia = a.turnId !== undefined ? (turnIndexById.get(a.turnId) ?? 0) : 0;
    const ib = b.turnId !== undefined ? (turnIndexById.get(b.turnId) ?? 0) : 0;
    return ib - ia;
  });

  sources.push(...turnEntries.map((e) => e.source));
  return { sources, sessionEdits };
}

const LARGE_FILE_LINE_THRESHOLD = 1000;
const EXPAND_CONTEXT_LINES = 999_999;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function isLargeEdit(before: string, after: string): boolean {
  return countLines(before) > LARGE_FILE_LINE_THRESHOLD || countLines(after) > LARGE_FILE_LINE_THRESHOLD;
}

function buildFilesFromSessionEdits(edits: readonly SessionEditWithTurn[]): DiffSelectorFile[] {
  const seen = new Set<string>();
  const files: DiffSelectorFile[] = [];
  for (const edit of edits) {
    if (seen.has(edit.path)) continue;
    seen.add(edit.path);
    const hasBefore = edit.before.length > 0;
    let additions = 0;
    let deletions = 0;
    if (isLargeEdit(edit.before, edit.after)) {
      additions = countLines(edit.after);
      deletions = countLines(edit.before);
    } else {
      const diffLines = computeDiffLines(edit.before, edit.after);
      for (const line of diffLines) {
        if (line.kind === 'add') additions++;
        else if (line.kind === 'delete') deletions++;
      }
    }
    files.push({
      path: edit.path,
      status: hasBefore ? 'modified' : 'added',
      source: 'session',
      turnId: edit.turnId,
      additions,
      deletions,
    });
  }
  return files;
}

function buildTurnSubtitle(
  turnNumber: number | undefined,
  turnId: string | undefined,
  turns: readonly TranscriptTurn[],
): string | undefined {
  if (turnNumber === undefined || turnId === undefined) return undefined;
  const turn = turns.find((t) => t.turnId === turnId);
  if (turn === undefined) return undefined;
  const userEntry = turn.entries.find((e) => e.kind === 'user');
  if (userEntry === undefined) return undefined;
  const text = userEntry.content.trim().replaceAll(/\s+/g, ' ');
  const max = 40;
  const truncated = text.length > max ? `${text.slice(0, max)}...` : text;
  return `Turn ${String(turnNumber)} "${truncated}"`;
}

function normalizeGitStatus(status: string): DiffSelectorFile['status'] | undefined {
  switch (status) {
    case 'modified':
      return 'modified';
    case 'added':
    case 'copied':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'untracked':
      return 'untracked';
    case 'renamed':
      // listChangedFiles passes --no-renames, so renames are reported as
      // separate delete/add entries. This branch is defensive only.
      return 'modified';
    default:
      // Filter out statuses we do not know how to render (e.g. ignored).
      return undefined;
  }
}

async function showDiffForChoice(
  host: SlashCommandHost,
  workDir: string,
  sessionEdits: readonly SessionEditWithTurn[],
  choice: DiffSelectorFile,
): Promise<void> {
  try {
    const lines = await buildDiffLinesForChoice(workDir, sessionEdits, choice);
    const panel = new DiffPanelComponent(() => lines);
    host.state.transcriptContainer.addChild(panel);
    host.state.ui.requestRender();
  } catch (error) {
    host.showError(formatErrorMessage(error));
  }
}

async function showDiffViewer(
  host: SlashCommandHost,
  workDir: string,
  sessionEdits: readonly SessionEditWithTurn[],
  choice: DiffSelectorFile,
  onBack: () => void,
): Promise<void> {
  const viewer = new DiffViewerComponent({
    onBack,
    onToggleExpand: (expanded) => buildDiffLinesForChoice(workDir, sessionEdits, choice, expanded),
    requestRender: () => host.state.ui.requestRender(),
  });
  host.mountEditorReplacement(viewer);

  try {
    const lines = await buildDiffLinesForChoice(workDir, sessionEdits, choice);
    viewer.setLines(lines);
    host.state.ui.requestRender();
  } catch (error) {
    host.showError(formatErrorMessage(error));
    onBack();
  }
}

async function buildDiffLinesForChoice(
  workDir: string,
  sessionEdits: readonly SessionEditWithTurn[],
  choice: DiffSelectorFile,
  expanded: boolean = false,
): Promise<readonly string[]> {
  const rawGitDiff =
    choice.source === 'git'
      ? await runGitDiffForFile(
          workDir,
          {
            path: choice.path,
            status: choice.status,
          },
          expanded ? EXPAND_CONTEXT_LINES : 3,
        )
      : undefined;

  if (choice.source === 'session') {
    return buildSessionEditLines(sessionEdits, choice.path, choice.turnId, {
      contextLines: expanded ? 10 : 2,
      maxLines: expanded ? undefined : 40,
    });
  }
  return buildDiffPanelLines(rawGitDiff ?? '');
}

interface SessionEditLineOptions {
  readonly contextLines?: number;
  readonly maxLines?: number;
}

function buildSessionEditLines(
  sessionEdits: readonly SessionEditWithTurn[],
  path: string,
  turnId: string | undefined,
  opts: SessionEditLineOptions = {},
): string[] {
  const edits = sessionEdits.filter((e) => e.path === path && e.turnId === turnId);
  if (edits.length === 0) return [];

  const output: string[] = [];
  for (const [index, edit] of edits.entries()) {
    if (index > 0) {
      output.push('');
      output.push('  ───────────────');
      output.push('');
    }
    if (isLargeEdit(edit.before, edit.after)) {
      const s = makeDiffStyles();
      const beforeLines = countLines(edit.before);
      const afterLines = countLines(edit.after);
      let header = '';
      if (afterLines > 0) header += s.addBold(`+${String(afterLines)} `);
      if (beforeLines > 0) header += s.delBold(`-${String(beforeLines)} `);
      header += path;
      output.push(header);
      output.push(
        currentTheme.fg(
          'textMuted',
          `  File too large to render inline diff (${beforeLines} → ${afterLines} lines).`,
        ),
      );
    } else {
      output.push(
        ...renderDiffLinesClustered(edit.before, edit.after, path, {
          contextLines: opts.contextLines ?? 2,
          maxLines: opts.maxLines ?? 40,
        }),
      );
    }
  }
  return output;
}
