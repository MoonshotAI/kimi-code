/**
 * Workflow registry — built-in and user-defined workflow scripts.
 *
 * Built-in scripts are embedded at build time via `?raw` imports.
 * User scripts live as `.js` files in `~/.kimi-code/workflows/`.
 *
 * The `meta` export is parsed with a regex-based extractor (no eval) —
 * only string-keyed object literals with string values are accepted.
 */

import { join } from 'pathe';
import { readFile } from 'node:fs/promises';

import type { WorkflowEntry, WorkflowMeta } from './workflowTypes';

// ── Built-in scripts ──────────────────────────────────────────────
import DEEP_RESEARCH_SCRIPT from './builtin/deep-research.js?raw';

const BUILTIN_SCRIPTS: readonly { file: string; script: string }[] = [
  { file: 'deep-research.js', script: DEEP_RESEARCH_SCRIPT },
];

const REGISTRY: Record<string, WorkflowEntry> = Object.create(null);

for (const { file, script } of BUILTIN_SCRIPTS) {
  const meta = parseMeta(script);
  if (meta === undefined) {
    throw new Error(`Built-in workflow ${file} has invalid or missing meta`);
  }
  REGISTRY[meta.name] = { meta, script };
}

export function listBuiltins(): readonly WorkflowMeta[] {
  return Object.values(REGISTRY).map((e) => e.meta).sort((a, b) => a.name.localeCompare(b.name));
}

export function getBuiltin(name: string): WorkflowEntry | undefined {
  return REGISTRY[name];
}

/**
 * Resolve a user-defined workflow by name. Walks `~/.kimi-code/workflows/`
 * for `<name>.js`. Returns undefined if not found.
 */
export async function resolveUserWorkflow(
  homeDir: string,
  name: string,
): Promise<WorkflowEntry | undefined> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  const filePath = join(homeDir, 'workflows', `${name}.js`);
  try {
    const script = await readFile(filePath, 'utf-8');
    const meta = parseMeta(script);
    if (meta === undefined) return undefined;
    return { meta, script };
  } catch {
    return undefined;
  }
}

/**
 * Parse `export const meta = { name: "...", description: "...", ... }`
 * from a script source. Regex-based — no eval. Only accepts string
 * keys with string values and optional trailing commas.
 */
export function parseMeta(script: string): WorkflowMeta | undefined {
  const metaMatch = script.match(/export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}/);
  if (!metaMatch || !metaMatch[1]) return undefined;

  const body = metaMatch[1];
  const fields: Record<string, string> = {};

  // Match `key: "value"` or `key: 'value'` pairs.
  const fieldRegex = /(\w+)\s*:\s*["']([^"']*?)["']/g;
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(body)) !== null) {
    if (match[1] && match[2]) {
      fields[match[1]] = match[2];
    }
  }

  // Also match array values for phases: phases: ["a", "b", "c"]
  const phasesMatch = body.match(/phases\s*:\s*\[([\s\S]*?)\]/);
  const phases: string[] = [];
  if (phasesMatch && phasesMatch[1]) {
    const phaseRegex = /["']([^"']*?)["']/g;
    let pm: RegExpExecArray | null;
    while ((pm = phaseRegex.exec(phasesMatch[1])) !== null) {
      if (pm[1]) phases.push(pm[1]);
    }
  }

  if (typeof fields['name'] !== 'string' || typeof fields['description'] !== 'string') {
    return undefined;
  }

  return {
    name: fields['name'],
    description: fields['description'],
    whenToUse: fields['whenToUse'],
    phases: phases.length > 0 ? phases : undefined,
  };
}
