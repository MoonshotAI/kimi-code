import { copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PlansStepInput {
  readonly targetHome: string;
  /**
   * kimi-cli hardcodes plan files at `~/.kimi/plans` regardless of
   * KIMI_SHARE_DIR (`tools/plan/heroes.py`), so the source is resolved from the
   * user's home, never from the migration source home. Injectable for tests.
   */
  readonly plansSourceDir?: string;
}

export interface PlansStepResult {
  readonly copied: number;
  readonly skippedExisting: number;
}

export function defaultPlansSourceDir(): string {
  return join(homedir(), '.kimi', 'plans');
}

export async function migratePlansStep(input: PlansStepInput): Promise<PlansStepResult> {
  const srcDir = input.plansSourceDir ?? defaultPlansSourceDir();
  const tgtDir = join(input.targetHome, 'plans');

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
    // Copy atomically: a crash mid-copy leaves only the temp file, never a
    // truncated final file that the next run would skip as complete.
    const tmpPath = `${tgtPath}.${process.pid}.tmp`;
    await copyFile(srcPath, tmpPath);
    await rename(tmpPath, tgtPath);
    copied++;
  }

  return { copied, skippedExisting };
}
