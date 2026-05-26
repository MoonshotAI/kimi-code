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

/**
 * Copy the user's legacy skills tree (~/.kimi/skills/) into kimi-code's
 * default user skills root (~/.kimi-code/skills/). Granularity is one
 * top-level entry per "skill unit" — that matches how the new scanner
 * treats a directory containing SKILL.md as a bundle and a flat .md as a
 * skill on its own. We do not filter non-skill entries; the new scanner
 * ignores anything it cannot parse, so passing it through preserves
 * arbitrary user assets without imposing a schema here.
 */
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

    // Defer creating the target root until we know there is something to put
    // in it — touching it earlier would fail when ~/.kimi-code/skills is
    // blocked by a file or has restrictive permissions, turning an empty
    // source into a hard error.
    if (!targetDirReady) {
      await mkdir(tgtDir, { recursive: true, mode: 0o700 });
      targetDirReady = true;
    }

    // Copy to a sibling temp path and rename into place so a crash mid-copy
    // never leaves a half-populated skill directory that the next idempotent
    // re-run would then `existsSync` and skip.
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
