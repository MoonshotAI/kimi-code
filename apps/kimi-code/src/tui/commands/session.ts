import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { detectInstallSource } from '#/cli/update/source';
import { detectShellEnvironment } from '#/utils/process/shell-env';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { isAbortError } from '../utils/errors';
import { formatErrorMessage } from '../utils/event-payload';
import { buildExportMarkdown } from '../utils/export-markdown';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(
      current !== null && current.length > 0
        ? `Session title: ${current}`
        : `Session title: (not set) — id: ${host.state.appState.sessionId}`,
    );
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const newTitle = title.slice(0, 200);
  try {
    await host.harness.renameSession({ id: session.id, title: newTitle });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set title: ${msg}`);
    return;
  }
  host.showStatus(`Session title set to: ${newTitle}`);
}

export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  void args;
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const sourceTitle = forkSourceTitle(host, session);
  let forked: Session;
  try {
    forked = await host.harness.forkSession({
      id: session.id,
      title: `Fork: ${sourceTitle}`,
    });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to fork session: ${msg}`);
    return;
  }

  try {
    await host.switchToSession(
      forked,
      `Session forked (${forked.id}). To return to the original session: kimi -r ${session.id}`,
    );
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch to forked session: ${msg}`);
  }
}

export async function handleAddDirCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const dir = args.trim();
  if (dir.length === 0) {
    await showAddDirPicker(host);
    return;
  }

  await addDirectoryToSession(host, dir);
}

async function addDirectoryToSession(host: SlashCommandHost, dir: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  try {
    const result = await session.addDirectory(dir);
    host.addWorkspaceDirectory?.(result.path);
    host.showStatus(
      result.added
        ? `Added directory to session: ${result.path}`
        : `Directory already available in this session: ${result.path}`,
    );
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to add directory: ${msg}`);
  }
}

async function showAddDirPicker(host: SlashCommandHost): Promise<void> {
  const options = await nearbyDirectoryOptions(host.state.appState.workDir);
  if (options.length === 0) {
    host.showError('No nearby directories found. Usage: /add-dir <directory>');
    return;
  }

  const picker = new ChoicePickerComponent({
    title: 'Add Directory',
    hint: 'type to search · Enter add · Esc cancel',
    options,
    colors: host.state.theme.colors,
    searchable: true,
    pageSize: 8,
    onSelect: (value) => {
      host.restoreEditor();
      void addDirectoryToSession(host, value);
    },
    onCancel: () => {
      host.restoreEditor();
      host.showStatus('Add directory cancelled.');
    },
  });
  host.mountEditorReplacement(picker);
}

export function handleDirsCommand(host: SlashCommandHost): void {
  const primary = host.state.appState.workDir;
  const additional = host.state.appState.additionalWorkspaceDirs ?? [];
  const picker = new ChoicePickerComponent({
    title: 'Session Directories',
    hint: 'type to search · Enter show path · Esc close',
    notice:
      additional.length === 0
        ? 'No extra directories'
        : `${String(additional.length)} extra ${additional.length === 1 ? 'directory' : 'directories'}`,
    options: directoryListOptions(primary, additional),
    currentValue: primary,
    colors: host.state.theme.colors,
    searchable: true,
    pageSize: 8,
    onSelect: (value) => {
      host.restoreEditor();
      host.showStatus(`Directory: ${value}`);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

export async function handleRemoveDirCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const dir = args.trim();
  if (dir.length === 0) {
    showRemoveDirPicker(host);
    return;
  }

  await removeDirectoryFromSession(host, dir);
}

async function removeDirectoryFromSession(host: SlashCommandHost, dir: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  try {
    const result = await session.removeDirectory(dir);
    if (result.removed) {
      host.removeWorkspaceDirectory?.(result.path);
    }
    host.showStatus(
      result.removed
        ? `Removed directory from session: ${result.path}`
        : `Directory was not an extra session directory: ${result.path}`,
    );
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to remove directory: ${msg}`);
  }
}

function showRemoveDirPicker(host: SlashCommandHost): void {
  const options = (host.state.appState.additionalWorkspaceDirs ?? []).map((dir) => ({
    value: dir,
    label: basename(dir) || dir,
    description: dir,
  }));
  if (options.length === 0) {
    host.showStatus('No extra directories in this session.');
    return;
  }

  const picker = new ChoicePickerComponent({
    title: 'Remove Directory',
    hint: 'type to search · Enter remove · Esc cancel',
    options,
    colors: host.state.theme.colors,
    searchable: true,
    pageSize: 8,
    onSelect: (value) => {
      host.restoreEditor();
      void removeDirectoryFromSession(host, value);
    },
    onCancel: () => {
      host.restoreEditor();
      host.showStatus('Remove directory cancelled.');
    },
  });
  host.mountEditorReplacement(picker);
}

function directoryListOptions(primary: string, additional: readonly string[]): ChoiceOption[] {
  return [
    {
      value: primary,
      label: 'Primary workspace',
      description: primary,
    },
    ...additional.map((dir, index) => ({
      value: dir,
      label: `Extra ${String(index + 1)}: ${basename(dir) || dir}`,
      description: dir,
    })),
  ];
}

async function nearbyDirectoryOptions(workDir: string): Promise<ChoiceOption[]> {
  const parent = resolve(workDir, '..');
  const options: ChoiceOption[] = [
    {
      value: parent,
      label: '..',
      description: parent,
    },
  ];

  let entries;
  try {
    entries = await readdir(workDir, { withFileTypes: true });
  } catch {
    return options;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.git') continue;
    const path = resolve(workDir, entry.name);
    options.push({
      value: path,
      label: entry.name,
      description: path,
    });
  }
  return options.toSorted((a, b) => {
    if (a.label === '..') return -1;
    if (b.label === '..') return 1;
    return a.label.localeCompare(b.label);
  });
}

function forkSourceTitle(host: SlashCommandHost, session: Session): string {
  const currentTitle = host.state.appState.sessionTitle?.trim();
  if (currentTitle !== undefined && currentTitle.length > 0) return currentTitle;

  const summaryTitle =
    typeof session.summary?.title === 'string' ? session.summary.title.trim() : '';
  return summaryTitle.length > 0 ? summaryTitle : session.id;
}

export async function handleExportMdCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session as Markdown…');
  try {
    const context = await session.getContext();
    if (context.history.length === 0) {
      host.showError('No messages to export.');
      return;
    }

    const now = new Date();
    const shortId = session.id.slice(0, 8);
    const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
    const defaultName = `kimi-export-${shortId}-${timestamp}.md`;

    const trimmedArgs = args.trim();
    const outputPath = trimmedArgs.length > 0
      ? resolve(trimmedArgs)
      : resolve(host.state.appState.workDir, defaultName);

    const md = buildExportMarkdown({
      sessionId: session.id,
      workDir: host.state.appState.workDir,
      history: context.history,
      tokenCount: context.tokenCount,
      now,
    });

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, md, 'utf-8');

    const linked = toTerminalHyperlink(outputPath, pathToFileURL(outputPath).href);
    host.showNotice(`Exported ${String(context.history.length)} messages`, linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleExportDebugZipCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  host.showStatus('Exporting session…');
  try {
    const installSource = await detectInstallSource();
    const shellEnv = detectShellEnvironment();
    const result = await host.harness.exportSession({
      id: session.id,
      version: host.state.appState.version,
      installSource,
      shellEnv,
      includeGlobalLog: true,
    });
    const linked = toTerminalHyperlink(result.zipPath, pathToFileURL(result.zipPath).href);
    host.showNotice('Export complete', linked);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to export session: ${msg}`);
  }
}

export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.deferUserMessages = true;
  host.beginSessionRequest();
  try {
    await session.init();
    host.track('init_complete');
    host.streamingUI.finalizeTurn((item) => {
      host.sendQueuedMessage(session, item);
    });
  } catch (error) {
    if (isAbortError(error)) {
      host.setAppState({ streamingPhase: 'idle' });
      host.resetLivePane();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    host.failSessionRequest(`Init failed: ${msg}`);
  } finally {
    host.deferUserMessages = false;
  }
}
