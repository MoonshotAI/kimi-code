import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const LEGACY_REQUIRED_SMOKE = ['agent-core-v2', 'scenarios', 'cli', 'smoke'];
const KINDS = ['smoke', 'regression', 'contract'] as const;
const RUNNERS = ['vitest', 'playwright'] as const;
const SMOKE_TAG: Record<ProtectedRunner, string> = { vitest: 'smoke', playwright: '@smoke' };

export type ProtectedKind = typeof KINDS[number];
export type ProtectedRunner = typeof RUNNERS[number];
export type GateScope = 'smoke' | 'all';

export interface ProtectedCase {
  id: string;
  kind: ProtectedKind;
  runner: ProtectedRunner;
  project: string;
  file: string;
  behavior: string;
  source: string;
  owner: string;
}

export interface ProtectedManifest {
  cases: ProtectedCase[];
  requireSmoke: string[];
}

export interface ProtectedExecution {
  title: string;
  file: string;
  project: string;
  status: string;
  passed: boolean;
  tags: readonly string[];
}

export function gateScope(value: string | undefined = process.env['KIMI_L0_SCOPE']): GateScope {
  if (value === undefined || value === '' || value === 'smoke') return 'smoke';
  if (value === 'all') return 'all';
  throw new Error(`KIMI_L0_SCOPE must be "smoke" or "all", got ${JSON.stringify(value)}`);
}

export interface CheckOptions {
  manifest?: ProtectedCase[];
  scope?: GateScope;
}

function textField(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function caseOf(raw: unknown, legacy: boolean, path: string): ProtectedCase {
  const entry = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const project = textField(entry, 'project');
  const kind = legacy ? 'smoke' : textField(entry, 'kind');
  const runner = legacy ? (project === 'smoke' ? 'playwright' : 'vitest') : textField(entry, 'runner');
  const [id, file, behavior, source, owner] = ['id', 'file', 'behavior', 'source', 'owner'].map(key => textField(entry, key));
  const valid = id !== undefined && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)
    && file !== undefined && relative(root, resolve(root, file)).split(sep).join('/') === file && !file.startsWith('../')
    && project !== undefined && behavior !== undefined && source !== undefined && owner !== undefined
    && KINDS.some(candidate => candidate === kind) && RUNNERS.some(candidate => candidate === runner);
  if (!valid) throw new Error(`Invalid L0 entry in ${path}: ${JSON.stringify(raw)}`);
  if (runner === 'playwright' && kind !== 'smoke') {
    throw new Error(`L0 ${id} in ${path}: Playwright entries must be smoke, because only the Electron smoke run is required`);
  }
  return { id, kind: kind as ProtectedKind, runner: runner as ProtectedRunner, project, file, behavior, source, owner };
}

export function readProtectedManifest(path: string): ProtectedManifest {
  const doc: unknown = parse(readFileSync(path, 'utf8'));
  const fields = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  const legacy = Array.isArray(fields['smoke']) && fields['protected'] === undefined;
  const entries = legacy ? fields['smoke'] : fields['protected'];
  const requireSmoke = legacy ? LEGACY_REQUIRED_SMOKE : fields['require_smoke'];
  if (!Array.isArray(entries) || !Array.isArray(requireSmoke) || !requireSmoke.every(layer => typeof layer === 'string' && layer !== '')) {
    throw new Error(`Invalid L0 manifest: ${path} needs a protected list and require_smoke project names`);
  }
  const ids = new Set<string>();
  const cases: ProtectedCase[] = [];
  for (const raw of entries) {
    const entry = caseOf(raw, legacy, path);
    if (ids.has(entry.id)) throw new Error(`Duplicate L0 ID in ${path}: ${entry.id}`);
    ids.add(entry.id);
    cases.push(entry);
  }
  return { cases, requireSmoke: requireSmoke as string[] };
}

export function protectedCases(
  path = resolve(root, 'tests/protected.yaml'),
  basePath = process.env['KIMI_L0_BASE_MANIFEST'],
): ProtectedCase[] {
  const head = readProtectedManifest(path);
  const baseManifest = basePath ? readProtectedManifest(basePath) : undefined;
  const base = baseManifest?.cases ?? [];
  for (const project of new Set([...head.requireSmoke, ...(baseManifest?.requireSmoke ?? [])])) {
    if (head.cases.some(entry => entry.kind === 'smoke' && entry.project === project)) continue;
    const ids = base.filter(entry => entry.kind === 'smoke' && entry.project === project).map(entry => entry.id);
    throw new Error(`No L0 smoke registered for ${project} in ${path}; base IDs: ${ids.join(', ') || '(none)'}`);
  }
  return [...head.cases, ...base.filter(old => !head.cases.some(entry => entry.id === old.id))];
}

export function checkProtectedExecutions(runner: ProtectedRunner, executions: ProtectedExecution[], options: CheckOptions = {}): string[] {
  const manifest = options.manifest ?? protectedCases();
  const scope = options.scope ?? 'smoke';
  const registered = manifest.filter(entry => entry.runner === runner);
  const expected = registered.filter(entry => scope === 'all' || entry.kind === 'smoke');
  const seen = new Map<string, ProtectedExecution[]>();
  const errors: string[] = [];
  for (const execution of executions) {
    const match = /^\[L0:([^\]]+)\]/.exec(execution.title);
    if (!match) continue;
    const id = match[1]!;
    if (!registered.some(entry => entry.id === id)) errors.push(`Unregistered L0 ${id} in ${execution.file} (${execution.project})`);
    const matches = seen.get(id) ?? [];
    matches.push(execution);
    seen.set(id, matches);
  }
  for (const entry of expected) {
    const matches = seen.get(entry.id) ?? [];
    const label = `L0 ${entry.id} (${entry.kind}) [${entry.project}] ${entry.file} — ${entry.behavior}`;
    if (matches.length === 0) {
      errors.push(`${label}: missing from runner results`);
    } else if (matches.length > 1) {
      errors.push(`${label}: duplicate ID on ${matches.length} tests`);
    } else {
      const result = matches[0]!;
      const file = relative(root, resolve(root, result.file)).split(sep).join('/');
      if (file !== entry.file || result.project !== entry.project) errors.push(`${label}: found at ${result.project}/${file}`);
      else if (!result.passed) errors.push(`${label}: did not pass on its first attempt (${result.status})`);
      else if (entry.kind === 'smoke' && !result.tags.includes(SMOKE_TAG[runner])) errors.push(`${label}: registered as smoke but lacks the ${SMOKE_TAG[runner]} tag`);
    }
  }
  return errors;
}
