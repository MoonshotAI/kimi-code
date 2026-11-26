import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';

export interface ResumeElsewhereHint {
  readonly summary: string;
  readonly detail: string;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function isDirectoryAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function resumeElsewhereHint(sessionId: string, sessionDir: string): ResumeElsewhereHint {
  return isDirectory(sessionDir)
    ? {
        summary: `Session "${sessionId}" was created under a different directory.`,
        detail: `  cd "${sessionDir}" && kimi -r ${sessionId}`,
      }
    : {
        summary: `Session "${sessionId}" was created in a directory that no longer exists.`,
        detail: `  ${sessionDir}`,
      };
}
