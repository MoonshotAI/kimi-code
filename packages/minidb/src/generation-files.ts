// src/generation-files.ts
//
// The pure file-level protocol of persistent index generations (stage 5):
// reading/writing CURRENT and the manifest, the atomic publish rename
// sequence, and the retention sweeps. No MiniDb state lives here — the
// builder (generation-build in index.ts) and the loader (generation-load in
// index.ts) drive these primitives.
//
// Publish order is the crash-safety contract (see generation.ts' header):
// every generation file is written + fsynced inside g-N.tmp-*, the manifest
// goes LAST, the tmp dir is fsynced, renamed to g-N, generations/ is fsynced,
// and only then is CURRENT atomically replaced (tmp + rename + db-dir fsync).
// A crash at any earlier point leaves CURRENT pointing at the previous
// complete generation; the stranded tmp dir is swept by the next writer.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fsyncDir } from './compaction.js';
import {
  CURRENT_FILE,
  GENERATIONS_DIR,
  GENERATION_FORMAT_VERSION,
  GEN_TMP_PATTERN,
  MANIFEST_FILE,
  parseGenerationId,
} from './generation.js';
import type { GenerationManifest } from './generation.js';
import { GenerationCorruptError } from './gen-codec.js';
import { renameReplace } from './rename-replace.js';

export function generationsDir(dir: string): string {
  return path.join(dir, GENERATIONS_DIR);
}

export function generationDir(dir: string, id: string): string {
  return path.join(dir, GENERATIONS_DIR, id);
}

/** The published generation id (one line), or null when no generation has
 *  ever been published (legacy database) or CURRENT is unreadable junk —
 *  both mean "use the legacy full recovery". Never throws on missing/corrupt
 *  content: CURRENT is a hint, the manifest validation is the gate. */
export async function readCurrent(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, CURRENT_FILE), 'utf8');
    const id = raw.trim();
    return parseGenerationId(id) === null ? null : id;
  } catch {
    return null;
  }
}

/** List generation directories (both published and stray tmp dirs), newest
 *  first by numeric id. */
export async function listGenerations(dir: string): Promise<{ id: string; n: number; tmp: boolean }[]> {
  let names: string[];
  try {
    names = await fs.readdir(generationsDir(dir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: { id: string; n: number; tmp: boolean }[] = [];
  for (const name of names) {
    if (GEN_TMP_PATTERN.test(name)) {
      const n = parseGenerationId(name.split('.tmp-')[0]!);
      if (n !== null) out.push({ id: name, n, tmp: true });
      continue;
    }
    const n = parseGenerationId(name);
    if (n !== null) out.push({ id: name, n, tmp: false });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

/** Read + validate a generation's manifest. Throws GenerationCorruptError on
 *  any structural violation — INCLUDING an unknown (newer) format version:
 *  the caller must fall back WITHOUT deleting anything, so a newer binary's
 *  generations survive an older binary's open. */
export async function readManifest(dir: string, id: string): Promise<GenerationManifest> {
  let parsed: GenerationManifest;
  try {
    const raw = await fs.readFile(path.join(generationDir(dir, id), MANIFEST_FILE), 'utf8');
    parsed = JSON.parse(raw) as GenerationManifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GenerationCorruptError(`generation ${id}: manifest missing`);
    }
    throw new GenerationCorruptError(`generation ${id}: manifest unreadable: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new GenerationCorruptError(`generation ${id}: manifest not an object`);
  if (parsed.format !== GENERATION_FORMAT_VERSION) {
    throw new GenerationCorruptError(`generation ${id}: unknown format version ${String(parsed.format)}`);
  }
  if (parsed.id !== id) throw new GenerationCorruptError(`generation ${id}: manifest id mismatch (${String(parsed.id)})`);
  const cp = parsed.checkpoint;
  if (
    !cp ||
    typeof cp.walOffset !== 'number' ||
    typeof cp.walDev !== 'number' ||
    typeof cp.walIno !== 'number' ||
    typeof cp.walSize !== 'number' ||
    cp.walOffset < 0 ||
    cp.walSize < cp.walOffset
  ) {
    throw new GenerationCorruptError(`generation ${id}: manifest checkpoint invalid`);
  }
  if (parsed.valueMode !== 'memory' && parsed.valueMode !== 'disk') {
    throw new GenerationCorruptError(`generation ${id}: unknown value mode`);
  }
  if (typeof parsed.files !== 'object' || parsed.files === null) {
    throw new GenerationCorruptError(`generation ${id}: manifest files invalid`);
  }
  return parsed;
}

/** Write the manifest LAST inside the tmp generation dir and fsync it (every
 *  payload file is already durable, so a visible manifest implies a complete
 *  generation). */
export async function writeManifest(tmpDir: string, manifest: GenerationManifest): Promise<void> {
  const p = path.join(tmpDir, MANIFEST_FILE);
  const h = await fs.open(p, 'w');
  try {
    await h.writeFile(JSON.stringify(manifest, null, 1), 'utf8');
    await h.sync();
  } finally {
    await h.close().catch(() => {});
  }
}

/** The publish sequence: rename the fully-written tmp dir to its final
 *  generation name, fsync generations/, then atomically replace CURRENT and
 *  fsync the db dir. After this resolves, openers can only see either the
 *  previous CURRENT or a complete generation — never a partial one. */
export async function publishGeneration(
  dir: string,
  tmpName: string,
  id: string,
  opts: { stats?: { dirFsyncUnsupported?: boolean } } = {},
): Promise<void> {
  const gens = generationsDir(dir);
  await renameReplace(path.join(gens, tmpName), path.join(gens, id));
  await fsyncDir(gens, { strict: true, stats: opts.stats });
  // CURRENT: unique tmp + fsync + rename + strict db-dir fsync (the same
  // discipline as the sidecar atomic writes).
  const currentTmp = path.join(dir, `${CURRENT_FILE}.tmp-${process.pid}-${Date.now()}`);
  try {
    const h = await fs.open(currentTmp, 'w');
    try {
      await h.writeFile(`${id}\n`, 'utf8');
      await h.sync();
    } finally {
      await h.close().catch(() => {});
    }
    await renameReplace(currentTmp, path.join(dir, CURRENT_FILE));
  } finally {
    await fs.rm(currentTmp, { force: true }).catch(() => {});
  }
  await fsyncDir(dir, { strict: true, stats: opts.stats });
}

/** Remove every generation directory that is neither in `keep`, nor the
 *  CURRENT-published one (re-read HERE, so concurrent cleanups with stale
 *  keep-sets can never delete the live generation — a cleanup racing a later
 *  publish must not remove what CURRENT now names), nor a live tmp build.
 *  Best-effort: failures are counted, never thrown (a stray directory wastes
 *  disk but can never corrupt the CURRENT-pointed state). */
export async function cleanupGenerations(dir: string, keep: ReadonlySet<string>): Promise<number> {
  const keepAll = new Set(keep);
  const current = await readCurrent(dir);
  if (current) keepAll.add(current);
  let errors = 0;
  for (const g of await listGenerations(dir)) {
    if (keepAll.has(g.id)) continue;
    try {
      await fs.rm(path.join(generationsDir(dir), g.id), { recursive: true, force: true });
    } catch {
      errors++;
    }
  }
  return errors;
}

/** Open-time sweep (writer only): remove stranded build tmp dirs. */
export async function sweepGenerationTemps(dir: string): Promise<void> {
  for (const g of await listGenerations(dir)) {
    if (g.tmp) await fs.rm(path.join(generationsDir(dir), g.id), { recursive: true, force: true }).catch(() => {});
  }
}
