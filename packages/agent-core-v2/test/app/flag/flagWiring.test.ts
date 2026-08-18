import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = join(import.meta.dirname, '../../../src');
const packageEntry = join(sourceRoot, 'index.ts');
const flagRegistryModule = join(sourceRoot, 'app/flag/flagRegistry.ts');

const RUNTIME_EDGE =
  /(?:^|\n)\s*(?:import\s+(?!type[\s{])[^'"]*?from\s+|import\s+|export\s+(?!type[\s{])[^'"]*?from\s+)['"]([^'"]+)['"]/g;
const REGISTRATION_CALL = /\bregisterFlagDefinition\s*\(/;
const FLAG_ID_CONSTANT = /export\s+const\s+([A-Z0-9_]+_FLAG_ID)\s*=\s*['"]([^'"]+)['"]/g;

function keepsRuntimeSideEffects(statement: string): boolean {
  const open = statement.indexOf('{');
  if (open === -1) return true;
  const inner = statement.slice(open + 1, statement.lastIndexOf('}'));
  return inner
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => !part.startsWith('type '));
}

function listTypeScriptFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.ts')) result.push(absolute);
    }
  };
  visit(root);
  return result;
}

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('#/')) base = join(sourceRoot, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return undefined;
  const candidates = specifier.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    : [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function collectModulesReachableFromEntry(): Set<string> {
  const reachable = new Set<string>();
  const queue = [packageEntry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    const content = readFileSync(file, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, ' ');
    for (const match of content.matchAll(RUNTIME_EDGE)) {
      if (!keepsRuntimeSideEffects(match[0])) continue;
      const resolved = resolveSpecifier(file, match[1]!);
      if (resolved && !reachable.has(resolved)) queue.push(resolved);
    }
  }
  return reachable;
}

function findRegistrationModules(): string[] {
  return listTypeScriptFiles(sourceRoot)
    .filter((file) => file !== flagRegistryModule)
    .filter((file) => REGISTRATION_CALL.test(readFileSync(file, 'utf8')));
}

describe('experimental flag wiring', () => {
  it('loads every module that registers a flag definition from the package entry', () => {
    const reachable = collectModulesReachableFromEntry();
    const unwired = findRegistrationModules()
      .filter((file) => !reachable.has(file))
      .map((file) => relative(sourceRoot, file));
    expect(
      unwired,
      'these modules call registerFlagDefinition but are not reachable from src/index.ts, ' +
        'so their flags never get registered and every gate on them silently stays off. ' +
        "Import each module for its side effects from the package entry (see how src/index.ts imports '#/…/flag').",
    ).toEqual([]);
  });

  it('registers every exported *_FLAG_ID constant', () => {
    const registrationModules = findRegistrationModules();
    const registrationSource = registrationModules
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const unregistered: string[] = [];
    for (const file of listTypeScriptFiles(sourceRoot)) {
      if (registrationModules.includes(file)) continue;
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(FLAG_ID_CONSTANT)) {
        const name = match[1]!;
        const id = match[2]!;
        if (!new RegExp(`\\b${name}\\b`).test(registrationSource)) {
          unregistered.push(`${name} ('${id}') in ${relative(sourceRoot, file)}`);
        }
      }
    }
    expect(
      unregistered,
      'these exported flag id constants are never referenced by a module calling registerFlagDefinition, ' +
        'so gates evaluating them silently stay off. ' +
        'Register each flag in a flag module wired into the package entry (see src/features/tower/flag.ts).',
    ).toEqual([]);
  });
});
