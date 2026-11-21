import { statSync } from 'node:fs';

export interface ResumeElsewhereHint {
  readonly summary: string;
  readonly detail: string;
}

export function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resumeElsewhereHint(sessionId: string, sessionDir: string): ResumeElsewhereHint {
  return isExistingDirectory(sessionDir)
    ? {
        summary: `Session "${sessionId}" was created under a different directory.`,
        detail: `  cd "${sessionDir}" && kimi -r ${sessionId}`,
      }
    : {
        summary: `Session "${sessionId}" was created in a directory that no longer exists.`,
        detail: `  ${sessionDir}`,
      };
}
