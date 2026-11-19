import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const projects = ['agent-core-v2', 'scenarios', 'cli', 'smoke'] as const;

type Project = typeof projects[number];
export type SmokeRunner = 'vitest' | 'playwright';

interface ProtectedCase {
  id: string;
  file: string;
  project: Project;
  behavior: string;
  source: string;
  owner: string;
}

export interface SmokeExecution {
  title: string;
  file: string;
  project: string;
  status: string;
  passed: boolean;
}

function isCase(value: unknown): value is ProtectedCase {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return ['id', 'file', 'behavior', 'source', 'owner'].every(key => typeof entry[key] === 'string' && entry[key].trim() !== '')
    && projects.some(project => project === entry['project']);
}

export function readSmokeManifest(path: string): ProtectedCase[] {
  const doc: unknown = parse(readFileSync(path, 'utf8'));
  if (!doc || typeof doc !== 'object' || !('smoke' in doc) || !Array.isArray(doc.smoke)) {
    throw new Error(`Invalid L0 smoke manifest: ${path}`);
  }
  const ids = new Set<string>();
  const entries: ProtectedCase[] = [];
  for (const entry of doc.smoke) {
    if (!isCase(entry) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(entry.id)
      || relative(root, resolve(root, entry.file)).split(sep).join('/') !== entry.file || entry.file.startsWith('../')) {
      throw new Error(`Invalid L0 smoke entry in ${path}: ${JSON.stringify(entry)}`);
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate L0 ID in ${path}: ${entry.id}`);
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

export function protectedSmokeCases(
  path = resolve(root, 'tests/protected.yaml'),
  basePath = process.env['KIMI_L0_BASE_MANIFEST'],
): ProtectedCase[] {
  const entries = readSmokeManifest(path);
  const base = basePath ? readSmokeManifest(basePath) : [];
  for (const project of projects) {
    if (entries.some(entry => entry.project === project)) continue;
    const ids = base.filter(entry => entry.project === project).map(entry => entry.id);
    throw new Error(`No L0 smoke registered for ${project} in ${path}; base IDs: ${ids.join(', ') || '(none)'}`);
  }
  return [...entries, ...base.filter(old => !entries.some(entry => entry.id === old.id))];
}

export function checkSmokeExecutions(runner: SmokeRunner, executions: SmokeExecution[], manifest = protectedSmokeCases()): string[] {
  const expected = manifest.filter(entry => (entry.project === 'smoke') === (runner === 'playwright'));
  const seen = new Map<string, SmokeExecution[]>();
  const errors: string[] = [];
  for (const execution of executions) {
    const match = /^\[L0:([^\]]+)\]/.exec(execution.title);
    if (!match) continue;
    const id = match[1]!;
    if (!expected.some(entry => entry.id === id)) errors.push(`Unregistered L0 ${id} in ${execution.file} (${execution.project})`);
    const matches = seen.get(id) ?? [];
    matches.push(execution);
    seen.set(id, matches);
  }
  for (const entry of expected) {
    const matches = seen.get(entry.id) ?? [];
    const label = `L0 ${entry.id} [${entry.project}] ${entry.file} — ${entry.behavior}`;
    if (matches.length === 0) {
      errors.push(`${label}: missing from runner results`);
    } else if (matches.length > 1) {
      errors.push(`${label}: duplicate ID on ${matches.length} tests`);
    } else {
      const result = matches[0]!;
      const file = relative(root, result.file).split(sep).join('/');
      if (file !== entry.file || result.project !== entry.project) errors.push(`${label}: found at ${result.project}/${file}`);
      else if (!result.passed) errors.push(`${label}: did not pass as a normal smoke (${result.status})`);
    }
  }
  return errors;
}
