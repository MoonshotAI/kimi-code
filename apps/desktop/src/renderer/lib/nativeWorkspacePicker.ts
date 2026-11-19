import { hasDesktopBridge } from '@moonshot-ai/app-core/lib';

interface DesktopOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface DesktopBridge {
  showOpenDialog: (opts: Record<string, unknown>) => Promise<DesktopOpenDialogResult>;
}

export function canPickWorkspaceDirectory(): boolean {
  return hasDesktopBridge();
}

export type PickDirectoryResult =
  | { status: 'picked'; paths: string[] }
  | { status: 'canceled' }
  | { status: 'error' };

export async function pickWorkspaceDirectory(opts: { title: string }): Promise<PickDirectoryResult> {
  try {
    const result = await (window as unknown as { kimiDesktop: DesktopBridge }).kimiDesktop.showOpenDialog({
      title: opts.title,
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return { status: 'canceled' };
    return { status: 'picked', paths: result.filePaths };
  } catch {
    return { status: 'error' };
  }
}

export async function pickNativeFile(opts: { title: string; defaultPath?: string }): Promise<string | undefined> {
  const result = await (window as unknown as { kimiDesktop: DesktopBridge }).kimiDesktop.showOpenDialog({
    title: opts.title,
    defaultPath: opts.defaultPath,
    properties: ['openFile', 'showHiddenFiles'],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

export async function pickWorkspaceDirectoryWithFallback(opts: {
  title: string;
  fallback: () => Promise<string[]>;
}): Promise<string[]> {
  if (canPickWorkspaceDirectory()) {
    const result = await pickWorkspaceDirectory({ title: opts.title });
    if (result.status === 'picked') return result.paths;
    if (result.status === 'canceled') return [];
  }
  return opts.fallback();
}
