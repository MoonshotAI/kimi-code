import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'pathe';
import { parseOutputStyle, OutputStyleParseError } from './parser';
import { BUILTIN_OUTPUT_STYLES } from './builtin';
import type { OutputStyle, OutputStyleSource } from './types';

export interface OutputStylePathContext { readonly userHomeDir: string; readonly brandHomeDir?: string; readonly workDir: string; }
export interface LoadOutputStylesOptions {
  readonly paths: OutputStylePathContext;
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly readdir?: (p: string) => Promise<readonly string[]>;
  readonly readFile?: (p: string) => Promise<string>;
  readonly isDir?: (p: string) => Promise<boolean>;
}

export async function loadOutputStyles(options: LoadOutputStylesOptions): Promise<readonly OutputStyle[]> {
  const readdir = options.readdir ?? ((p) => fs.readdir(p));
  const readFile = options.readFile ?? ((p) => fs.readFile(p, 'utf8'));
  const isDir = options.isDir ?? (async (p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } });
  const warn = options.onWarning ?? (() => {});
  const { userHomeDir, workDir } = options.paths;
  const brandHomeDir = options.paths.brandHomeDir ?? join(userHomeDir, '.kimi-code');
  const projectRoot = await findProjectRoot(workDir);
  const byName = new Map<string, OutputStyle>();
  for (const s of BUILTIN_OUTPUT_STYLES) byName.set(s.name, s);
  await scanDir(join(brandHomeDir, 'output-styles'), 'user');
  await scanDir(join(projectRoot, '.kimi-code', 'output-styles'), 'project');
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));

  async function scanDir(dir: string, source: OutputStyleSource): Promise<void> {
    if (!(await isDir(dir))) return;
    let entries: readonly string[];
    try { entries = [...(await readdir(dir))].toSorted(); }
    catch (error) { warn(`Failed to read output-style directory ${dir}`, error); return; }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const file = join(dir, entry);
      try {
        const parsed = parseOutputStyle(await readFile(file), entry.slice(0, -'.md'.length));
        byName.set(parsed.name, { ...parsed, source });
      } catch (error) {
        if (error instanceof OutputStyleParseError) warn(`Skipping invalid output style at ${file}: ${error.message}`, error);
        else warn(`Skipping output style at ${file} due to unexpected error`, error);
      }
    }
  }
}

async function findProjectRoot(workDir: string): Promise<string> {
  let current = resolve(workDir);
  while (true) {
    try { await fs.stat(join(current, '.git')); return current; } catch { /* keep walking */ }
    const parent = dirname(current);
    if (parent === current) return resolve(workDir);
    current = parent;
  }
}
