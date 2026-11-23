import { constants } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';

import { dirname, join } from 'pathe';

export interface CopyIncludedFilesInput {
  readonly sourceRoot: string;
  readonly worktreeRoot: string;
  readonly files: readonly string[];
  readonly signal?: AbortSignal;
}

export async function copyIncludedFiles(input: CopyIncludedFilesInput): Promise<string[]> {
  const copied: string[] = [];
  const directories = new Set<string>(['.']);
  for (const file of input.files) {
    if (input.signal?.aborted === true) break;
    const source = join(input.sourceRoot, file);
    const stat = await lstat(source).catch((error: unknown) => {
      if (errnoCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (stat === undefined || !stat.isFile()) continue;
    if (!(await ensureRealDirectory(input.worktreeRoot, dirname(file), directories))) continue;
    try {
      await copyFile(source, join(input.worktreeRoot, file), constants.COPYFILE_EXCL);
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') continue;
      throw error;
    }
    copied.push(file);
  }
  return copied;
}

async function ensureRealDirectory(root: string, relativeDir: string, known: Set<string>): Promise<boolean> {
  if (known.has(relativeDir)) return true;
  if (!(await ensureRealDirectory(root, dirname(relativeDir), known))) return false;
  const path = join(root, relativeDir);
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined) await mkdir(path);
  else if (!stat.isDirectory()) return false;
  known.add(relativeDir);
  return true;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
