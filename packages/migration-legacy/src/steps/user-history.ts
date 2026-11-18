import { copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { sourceUserHistoryDir, targetUserHistoryDir } from '../paths.js';

export interface UserHistoryStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
}

export interface UserHistoryStepResult {
  readonly copied: number;
  readonly skippedExisting: number;
}

export async function migrateUserHistoryStep(
  input: UserHistoryStepInput,
): Promise<UserHistoryStepResult> {
  const srcDir = sourceUserHistoryDir(input.sourceHome);
  const tgtDir = targetUserHistoryDir(input.targetHome);

  let entries: string[];
  try {
    entries = await readdir(srcDir);
  } catch {
    return { copied: 0, skippedExisting: 0 };
  }

  let copied = 0;
  let skippedExisting = 0;
  let targetDirReady = false;
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    const tgtPath = join(tgtDir, name);
    let st: Stats;
    try {
      st = await stat(srcPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (existsSync(tgtPath)) {
      skippedExisting++;
      continue;
    }
    if (!targetDirReady) {
      await mkdir(tgtDir, { recursive: true, mode: 0o700 });
      targetDirReady = true;
    }
    const tmpPath = `${tgtPath}.${process.pid}.tmp`;
    await copyFile(srcPath, tmpPath);
    await rename(tmpPath, tgtPath);
    copied++;
  }

  return { copied, skippedExisting };
}
