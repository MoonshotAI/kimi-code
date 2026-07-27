import { app } from 'electron';
import type { JumpListCategory } from 'electron';

import type { TrayLocale } from './tray';

export interface JumpListWorkspace {
  name: string;
  root: string;
}

// Leave one of Windows' roughly 10 visible slots for the task category.
const MAX_WORKSPACES = 9;
const MAX_DESCRIPTION_LENGTH = 260;

export function asJumpListWorkspaces(value: unknown): JumpListWorkspace[] | null {
  if (!Array.isArray(value)) return null;
  const workspaces: JumpListWorkspace[] = [];
  for (const raw of value.slice(0, MAX_WORKSPACES)) {
    if (typeof raw !== 'object' || raw === null) return null;
    const candidate = raw as { name?: unknown; root?: unknown };
    if (
      typeof candidate.name !== 'string' ||
      typeof candidate.root !== 'string' ||
      candidate.root === ''
    ) {
      return null;
    }
    workspaces.push({ name: candidate.name, root: candidate.root });
  }
  return workspaces;
}

export interface LaunchAction {
  newChat: boolean;
  workspace?: string;
}

/** Apply Windows CommandLineToArgvW backslash escaping. */
export function quoteWindowsCommandLineArg(value: string): string {
  const escaped = value
    .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

function workspaceArgs(root: string): string {
  return `--workspace=${quoteWindowsCommandLineArg(root)}`;
}

export function filterRemovedJumpListWorkspaces(
  workspaces: readonly JumpListWorkspace[],
  removedItems: readonly { args?: string }[],
): JumpListWorkspace[] {
  const removedArgs = new Set(
    removedItems
      .map((item) => item.args)
      .filter((args): args is string => args !== undefined),
  );
  return workspaces.filter((workspace) => !removedArgs.has(workspaceArgs(workspace.root)));
}

function jumpListDescription(root: string): string {
  return root.length <= MAX_DESCRIPTION_LENGTH
    ? root
    : `${root.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
}

export function parseLaunchArgs(argv: readonly string[]): LaunchAction {
  let newChat = false;
  let workspace: string | undefined;
  for (const arg of argv) {
    if (arg === '--new-chat') {
      newChat = true;
    } else if (arg.startsWith('--workspace=')) {
      let value = arg.slice('--workspace='.length);
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (value !== '') workspace = value;
    }
  }
  return workspace === undefined ? { newChat } : { newChat, workspace };
}

const JUMP_LIST_STRINGS: Record<TrayLocale, { newChat: string; recent: string }> = {
  zh: { newChat: '新建会话', recent: '最近' },
  en: { newChat: 'New Session', recent: 'Recent' },
};

export function buildJumpListCategories(
  workspaces: JumpListWorkspace[],
  locale: TrayLocale,
  execPath: string,
): JumpListCategory[] {
  const strings = JUMP_LIST_STRINGS[locale];
  const categories: JumpListCategory[] = [];
  if (workspaces.length > 0) {
    categories.push({
      type: 'custom',
      name: strings.recent,
      items: workspaces.map((workspace) => ({
        type: 'task' as const,
        program: execPath,
        args: workspaceArgs(workspace.root),
        title: workspace.name,
        description: jumpListDescription(workspace.root),
        iconPath: execPath,
        iconIndex: 0,
      })),
    });
  }
  categories.push({
    type: 'tasks',
    items: [
      {
        type: 'task' as const,
        program: execPath,
        args: '--new-chat',
        title: strings.newChat,
        iconPath: execPath,
        iconIndex: 0,
      },
    ],
  });
  return categories;
}

let lastWorkspaces: JumpListWorkspace[] = [];
let jumpListLocale: TrayLocale | null = null;

function applyJumpList(): void {
  if (process.platform !== 'win32') return;
  let locale = jumpListLocale;
  if (locale === null) {
    try {
      locale = app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
    } catch {
      locale = 'en';
    }
  }
  try {
    const workspaces = filterRemovedJumpListWorkspaces(
      lastWorkspaces,
      app.getJumpListSettings().removedItems,
    );
    app.setJumpList(buildJumpListCategories(workspaces, locale, process.execPath));
  } catch {}
}

export function updateJumpList(workspaces: JumpListWorkspace[]): void {
  lastWorkspaces = workspaces;
  applyJumpList();
}

export function setJumpListLocale(locale: TrayLocale): void {
  if (locale === jumpListLocale) return;
  jumpListLocale = locale;
  applyJumpList();
}
