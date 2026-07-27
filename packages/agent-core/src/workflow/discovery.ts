/**
 * Workflow file discovery — a simplified version of the skill scanner
 * (`../skill/scanner.ts`): resolve `workflows/` roots across project / user /
 * extra / builtin scopes, then scan each root's direct `*.js` files.
 */
import { promises as fs } from 'node:fs';
import path from 'pathe';

import { extractWorkflowMeta } from './script';
import {
  DEFAULT_WORKFLOW_LIMITS,
  type SkippedWorkflow,
  type WorkflowDefinition,
  type WorkflowSource,
} from './types';
import { validateWorkflowName } from './validate';

export interface WorkflowRoot {
  path: string;
  source: WorkflowSource;
}

const PROJECT_BRAND_DIR = '.kimi-code/workflows';
const PROJECT_GENERIC_DIR = '.agents/workflows';
const USER_BRAND_DIR = 'workflows';
const USER_GENERIC_DIR = '.agents/workflows';

/** `src/workflow/builtin/` — populated by future slices (e.g. deep-research). */
const BUILTIN_WORKFLOWS_DIR = path.join(path.dirname(import.meta.filename.replaceAll('\\', '/')), 'builtin');

export interface ResolveWorkflowRootsOptions {
  workDir: string;
  /** Brand data dir (`KIMI_CODE_HOME`, defaults to `<osHome>/.kimi-code`). */
  kimiHome?: string;
  osHome?: string;
  extraDirs?: string[];
  includeBuiltin?: boolean;
}

export async function resolveWorkflowRoots(
  options: ResolveWorkflowRootsOptions,
): Promise<WorkflowRoot[]> {
  const roots: WorkflowRoot[] = [];
  const projectRoot = await findProjectRoot(options.workDir);
  const osHome = options.osHome;
  const kimiHome = options.kimiHome ?? (osHome !== undefined ? path.join(osHome, '.kimi-code') : undefined);

  await pushExistingRoot(roots, path.join(projectRoot, PROJECT_BRAND_DIR), 'project');
  await pushExistingRoot(roots, path.join(projectRoot, PROJECT_GENERIC_DIR), 'project');
  if (kimiHome !== undefined) {
    await pushExistingRoot(roots, path.join(kimiHome, USER_BRAND_DIR), 'user');
  }
  if (osHome !== undefined) {
    await pushExistingRoot(roots, path.join(osHome, USER_GENERIC_DIR), 'user');
  }
  for (const dir of options.extraDirs ?? []) {
    await pushExistingRoot(roots, resolveConfiguredDir(dir, projectRoot, osHome), 'extra');
  }
  if (options.includeBuiltin ?? true) {
    await pushExistingRoot(roots, BUILTIN_WORKFLOWS_DIR, 'builtin');
  }
  return roots;
}

export interface DiscoverWorkflowsOptions extends ResolveWorkflowRootsOptions {
  maxScriptBytes?: number;
}

export interface DiscoverWorkflowsResult {
  workflows: WorkflowDefinition[];
  skipped: SkippedWorkflow[];
}

export async function discoverWorkflows(
  options: DiscoverWorkflowsOptions,
): Promise<DiscoverWorkflowsResult> {
  const maxScriptBytes = options.maxScriptBytes ?? DEFAULT_WORKFLOW_LIMITS.maxScriptBytes;
  const roots = await resolveWorkflowRoots(options);
  const byName = new Map<string, WorkflowDefinition>();
  const skipped: SkippedWorkflow[] = [];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = (await fs.readdir(root.path)).toSorted();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.js')) continue;
      const filePath = path.join(root.path, entry);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > maxScriptBytes) {
          skipped.push({
            path: filePath,
            reason: `workflow script is too large: ${stat.size} bytes (max ${maxScriptBytes})`,
          });
          continue;
        }
        const script = await fs.readFile(filePath, 'utf8');
        const meta = extractWorkflowMeta(script, { filename: filePath, maxScriptBytes });
        const expectedName = entry.slice(0, -'.js'.length);
        if (meta.name !== expectedName) {
          skipped.push({
            path: filePath,
            reason: `workflow name "${meta.name}" does not match filename "${expectedName}"`,
          });
          continue;
        }
        // First root wins on name collisions (project > user > extra > builtin).
        if (!byName.has(meta.name)) {
          byName.set(meta.name, { meta, script, path: filePath, source: root.source });
        }
      } catch (error) {
        skipped.push({
          path: filePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { workflows: [...byName.values()], skipped };
}

export interface SaveWorkflowOptions {
  script: string;
  scope: 'project' | 'user';
  workDir: string;
  kimiHome?: string;
  osHome?: string;
  overwrite?: boolean;
  maxScriptBytes?: number;
}

export async function saveWorkflow(options: SaveWorkflowOptions): Promise<{ path: string }> {
  const maxScriptBytes = options.maxScriptBytes ?? DEFAULT_WORKFLOW_LIMITS.maxScriptBytes;
  const meta = extractWorkflowMeta(options.script, { maxScriptBytes });
  // Path-traversal guard: the file name is derived from the validated meta
  // name, never from caller-provided path segments.
  validateWorkflowName(meta.name);

  let dir: string;
  if (options.scope === 'project') {
    const projectRoot = await findProjectRoot(options.workDir);
    dir = path.join(projectRoot, PROJECT_BRAND_DIR);
  } else {
    const kimiHome =
      options.kimiHome ?? (options.osHome !== undefined ? path.join(options.osHome, '.kimi-code') : undefined);
    if (kimiHome === undefined) {
      throw new Error('saveWorkflow with scope "user" requires kimiHome or osHome');
    }
    dir = path.join(kimiHome, USER_BRAND_DIR);
  }

  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${meta.name}.js`);
  if (options.overwrite !== true && (await exists(filePath))) {
    throw new Error(`workflow file already exists: ${filePath}`);
  }
  await fs.writeFile(filePath, options.script, 'utf8');
  return { path: filePath };
}

async function pushExistingRoot(
  out: WorkflowRoot[],
  dir: string,
  source: WorkflowSource,
): Promise<void> {
  if (!(await isDir(dir))) return;
  const resolved = (await fs.realpath(dir)).replaceAll('\\', '/');
  if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
}

function resolveConfiguredDir(dir: string, projectRoot: string, osHome: string | undefined): string {
  if (osHome !== undefined) {
    if (dir === '~') return osHome;
    if (dir.startsWith('~/')) return path.join(osHome, dir.slice(2));
  }
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(projectRoot, dir);
}

// Mirrors the skill scanner's private findProjectRoot (not exported there):
// walk up until a `.git` entry, falling back to the starting directory.
async function findProjectRoot(workDir: string): Promise<string> {
  const start = path.resolve(workDir);
  let current = start;
  while (true) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
