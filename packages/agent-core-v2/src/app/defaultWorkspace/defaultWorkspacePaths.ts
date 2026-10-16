import { posix, win32 } from 'node:path';

import { isAbsolute, join, normalize } from 'pathe';

export const DEFAULT_WORKSPACE_RELATIVE_ROOT = ['KimiCode', 'Default'] as const;

export function parseXdgDocumentsDir(content: string, osHomeDir: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*XDG_DOCUMENTS_DIR\s*=\s*"(.*)"\s*$/.exec(line);
    if (match === null) continue;
    const raw = match[1]!;
    const expanded = raw.replace(/^\$HOME(?=\/|$)/, osHomeDir);
    if (!expanded.startsWith('/') || expanded === osHomeDir || expanded === `${osHomeDir}/`) {
      return undefined;
    }
    return expanded;
  }
  return undefined;
}

export const WINDOWS_DOCUMENTS_COMMAND =
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Environment]::GetFolderPath('MyDocuments')";

export function windowsPowerShellPath(systemRoot: string | undefined): string {
  const root =
    systemRoot !== undefined && /^[A-Za-z]:[\\/]/.test(systemRoot)
      ? systemRoot.replace(/[\\/]+$/, '')
      : 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export function parseWindowsDocumentsOutput(output: string): string | undefined {
  const dir = output.replace(/^\uFEFF/, '').trim();
  return dir.length > 0 && isAbsolute(dir) ? dir : undefined;
}

export function defaultDocumentsDir(osHomeDir: string): string {
  return join(osHomeDir, 'Documents');
}

const WINDOWS_QUALIFIED_ROOT = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

export function resolveCustomRoot(
  raw: string,
  osHomeDir: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === 'win32') {
    const expanded = /^~(?=$|[\\/])/.test(raw) ? osHomeDir + raw.slice(1) : raw;
    return WINDOWS_QUALIFIED_ROOT.test(expanded) ? normalize(win32.normalize(expanded)) : undefined;
  }
  const expanded = /^~(?=$|\/)/.test(raw) ? osHomeDir + raw.slice(1) : raw;
  return posix.isAbsolute(expanded) ? posix.normalize(expanded) : undefined;
}
