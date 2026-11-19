import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sourceSkillsDir, targetSkillsDir } from '../paths.js';

export interface SkillsStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
}

export interface SkillsStepResult {
  readonly copied: number;
  readonly skippedExisting: number;
}

export async function migrateSkillsStep(input: SkillsStepInput): Promise<SkillsStepResult> {
  const srcDir = sourceSkillsDir(input.sourceHome);
  const tgtDir = targetSkillsDir(input.targetHome);

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

    try {
      await stat(srcPath);
    } catch {
      continue;
    }

    if (existsSync(tgtPath)) {
      skippedExisting++;
      continue;
    }

    if (!targetDirReady) {
      await mkdir(tgtDir, { recursive: true, mode: 0o700 });
      targetDirReady = true;
    }

    const tmpPath = `${tgtPath}.${process.pid}.tmp`;
    try {
      await cp(srcPath, tmpPath, { recursive: true, errorOnExist: false, force: true });
      await rename(tmpPath, tgtPath);
    } catch (err) {
      await rm(tmpPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    copied++;
  }

  return { copied, skippedExisting };
}
