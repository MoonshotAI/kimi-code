import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Dependency-direction fence for agent-core.
 *
 * Pins the dependency-direction rules from
 * `packages/agent-core/src/services/AGENTS.md`. Three of those rules are
 * enforced here by grep over the source tree; the rest are convention-only
 * because they are not expressible as a static import check.
 *
 * Grep-enforced (this file):
 *  1. runtime ↛ services — `services/` is the upper facade; the runtime
 *     (`rpc/`, `session/`, `agent/`, `di/`, …) must NOT import back into
 *     `services/`. See {@link findViolations}.
 *  2. repository / index ↛ services — runtime-owned repositories and indexes
 *     (`*Repository.ts` / `*Index.ts` under a runtime dir) must NOT import
 *     from `services/`. This is a focused, explicitly-named restatement of
 *     rule 1 for the persistence layer. See
 *     {@link findRepositoryIndexServiceImports}.
 *  3. application services don't call each other's business methods — a
 *     `services/<domainA>/*Service.ts` impl must NOT import a CONCRETE impl
 *     from a different domain `services/<domainB>/*Service.ts` (A ≠ B). Type
 *     imports and contract imports (`<domainB>.ts`, `<domainB>/index.ts`) are
 *     allowed. See {@link findCrossServiceBusinessImports}.
 *
 * Convention-only (NOT grep-enforced here, documented in AGENTS.md):
 *  - Within a single domain, the command / query / runtime roles do not call
 *    each other's business methods. A sibling impl import inside the same
 *    domain folder (e.g. `sessionQueryService.ts` → `./sessionRuntimeService`)
 *    is intentionally NOT flagged by rule 3: it cannot be distinguished from a
 *    legitimate lower-layer composition by a cross-file grep, so it remains a
 *    code-review convention.
 *  - "Business method" vs "contract" is a semantic distinction; the fence
 *    approximates it as "concrete `*Service.ts` impl import" vs "anything
 *    else" and treats `import type` as non-business.
 *
 * Each detector is exported and driven by both a positive case (the current,
 * clean tree → 0 violations) and a planted negative fixture, so the positive
 * and negative paths run the exact same detection logic.
 */

const SRC = join(import.meta.dirname, '..', 'src');

const RUNTIME_DIRS = ['rpc', 'session', 'agent', 'di'] as const;

const SERVICES_BARE = '@moonshot-ai/agent-core/services';

// `import ... from 'x'` and `export ... from 'x'`.
const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]/g;
// Dynamic `import('x')`.
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Side-effect `import 'x'`.
const SIDE_EFFECT_RE = /\bimport\s*['"]([^'"]+)['"]/g;

// `import ... from 'x'` / `export ... from 'x'`, capturing the binding clause
// so type-only imports (`import type { X }`, `import { type X }`) can be told
// apart from value imports. Group 1 = `import`/`export`, 2 = clause, 3 = specifier.
const MODULE_FROM_RE = /\b(import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;

const SERVICE_IMPL_RE = /Service$/;

export interface DependencyViolation {
  /** Path of the offending file, relative to the scanned `srcRoot`. */
  file: string;
  /** The module specifier that points into `services/`. */
  specifier: string;
}

export interface CrossServiceViolation {
  /** Path of the offending impl file, relative to the scanned `srcRoot`. */
  file: string;
  /** Domain folder that owns the importing file. */
  fromDomain: string;
  /** Domain folder that owns the imported concrete impl. */
  toDomain: string;
  /** The module specifier that crosses the domain boundary. */
  specifier: string;
}

interface ModuleReference {
  specifier: string;
  /** True when every binding in the statement is type-only. */
  typeOnly: boolean;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  const specifiers: string[] = [];
  for (const re of [FROM_RE, DYNAMIC_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripped)) !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/**
 * Classify an `import`/`export ... from` binding clause. Returns true when the
 * whole statement is type-only and therefore must not be treated as a business
 * (value) dependency:
 *   - `import type { X } from ...` / `export type { X } from ...`
 *   - `import { type X, type Y } from ...` (inline `type` on every binding)
 * A statement carrying any value binding (default, namespace, or a non-`type`
 * named binding) is a value import and returns false.
 */
function isTypeOnlyImportClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/^type\b/.test(trimmed)) {
    return true;
  }
  if (/\*\s*as\s+/.test(trimmed)) {
    return false;
  }
  const braceMatch = trimmed.match(/\{([\s\S]*)\}/);
  if (!braceMatch) {
    return false;
  }
  const beforeBrace = trimmed.slice(0, braceMatch.index).replace(/,/g, '').trim();
  if (beforeBrace.length > 0) {
    // A default binding sits alongside the named group → value import.
    return false;
  }
  const bindings = braceMatch[1]
    ?.split(',')
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0);
  if (!bindings || bindings.length === 0) {
    return false;
  }
  return bindings.every((binding) => /^type\s+/.test(binding));
}

function extractModuleReferences(source: string): ModuleReference[] {
  const stripped = stripComments(source);
  const refs: ModuleReference[] = [];

  MODULE_FROM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MODULE_FROM_RE.exec(stripped)) !== null) {
    const clause = match[2] ?? '';
    const specifier = match[3];
    if (specifier !== undefined) {
      refs.push({ specifier, typeOnly: isTypeOnlyImportClause(clause) });
    }
  }

  for (const re of [DYNAMIC_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    while ((match = re.exec(stripped)) !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        refs.push({ specifier, typeOnly: false });
      }
    }
  }

  return refs;
}

function isServicesImport(specifier: string, fileDir: string, srcRoot: string): boolean {
  if (specifier === SERVICES_BARE || specifier.startsWith(`${SERVICES_BARE}/`)) {
    return true;
  }
  if (specifier.startsWith('.')) {
    const resolved = normalize(join(fileDir, specifier));
    const servicesRoot = normalize(join(srcRoot, 'services'));
    return resolved === servicesRoot || resolved.startsWith(`${servicesRoot}/`);
  }
  return false;
}

interface ServiceTarget {
  domain: string;
  moduleName: string;
}

/**
 * Resolve a module specifier to a `services/<domain>/<module>` target, or
 * `null` when it does not point into the services tree. `moduleName` is the
 * final path segment with any extension stripped, so impl detection can match
 * on the `*Service` suffix regardless of `../foo/fooService` vs
 * `../foo/fooService.ts`.
 */
function resolveServiceTarget(
  specifier: string,
  fileDir: string,
  srcRoot: string,
): ServiceTarget | null {
  const toTarget = (rest: string): ServiceTarget | null => {
    const parts = rest.split('/').filter((part) => part.length > 0);
    if (parts.length < 2) {
      // Points at the services barrel root or a domain barrel — not a concrete impl.
      return null;
    }
    const [domain, ...restParts] = parts;
    const leaf = restParts[restParts.length - 1];
    if (domain === undefined || leaf === undefined) {
      return null;
    }
    const moduleName = leaf.replace(/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, '');
    return { domain, moduleName };
  };

  if (specifier.startsWith('.')) {
    const resolved = normalize(join(fileDir, specifier));
    const servicesRoot = normalize(join(srcRoot, 'services'));
    if (!resolved.startsWith(`${servicesRoot}/`)) {
      return null;
    }
    return toTarget(resolved.slice(servicesRoot.length + 1));
  }

  const barePrefix = `${SERVICES_BARE}/`;
  if (specifier.startsWith(barePrefix)) {
    return toTarget(specifier.slice(barePrefix.length));
  }

  return null;
}

/**
 * Scan `runtimeDirs` under `srcRoot` and return every import whose specifier
 * resolves into the `<srcRoot>/services` subtree.
 *
 * Pure and exported so both the positive (real src) and negative (fixture)
 * cases drive the exact same detection logic — no duplicated regex.
 */
export function findViolations(
  srcRoot: string,
  runtimeDirs: readonly string[],
): DependencyViolation[] {
  const violations: DependencyViolation[] = [];
  for (const dir of runtimeDirs) {
    const absDir = join(srcRoot, dir);
    const files = globSync('**/*.ts', { cwd: absDir }).map((file) => file.split('\\').join('/'));
    for (const rel of files) {
      const absFile = join(absDir, rel);
      const source = readFileSync(absFile, 'utf8');
      const fileDir = dirname(absFile);
      for (const specifier of extractSpecifiers(source)) {
        if (isServicesImport(specifier, fileDir, srcRoot)) {
          violations.push({ file: `${dir}/${rel}`, specifier });
        }
      }
    }
  }
  return violations;
}

/**
 * Rule 2 — repository / index ↛ services. Focused restatement of rule 1 for
 * the persistence layer: only `*Repository.ts` / `*Index.ts` files under a
 * runtime dir are scanned, so the fixture and the report speak in the
 * vocabulary of the convention.
 */
export function findRepositoryIndexServiceImports(
  srcRoot: string,
  runtimeDirs: readonly string[],
): DependencyViolation[] {
  const violations: DependencyViolation[] = [];
  for (const dir of runtimeDirs) {
    const absDir = join(srcRoot, dir);
    const files = globSync('**/*.ts', { cwd: absDir })
      .map((file) => file.split('\\').join('/'))
      .filter((file) => file.endsWith('Repository.ts') || file.endsWith('Index.ts'));
    for (const rel of files) {
      const absFile = join(absDir, rel);
      const source = readFileSync(absFile, 'utf8');
      const fileDir = dirname(absFile);
      for (const specifier of extractSpecifiers(source)) {
        if (isServicesImport(specifier, fileDir, srcRoot)) {
          violations.push({ file: `${dir}/${rel}`, specifier });
        }
      }
    }
  }
  return violations;
}

/**
 * Rule 3 — application services don't call each other's business methods. A
 * `services/<domainA>/*Service.ts` impl importing a CONCRETE impl from a
 * different domain `services/<domainB>/*Service.ts` (A ≠ B) is flagged. Type
 * imports, contract imports (`<domainB>.ts` / `<domainB>/index.ts`), and
 * same-domain sibling imports are intentionally not flagged.
 */
export function findCrossServiceBusinessImports(srcRoot: string): CrossServiceViolation[] {
  const violations: CrossServiceViolation[] = [];
  const servicesRoot = join(srcRoot, 'services');
  const files = globSync('*/*Service.ts', { cwd: servicesRoot }).map((file) =>
    file.split('\\').join('/'),
  );
  for (const rel of files) {
    const slash = rel.indexOf('/');
    const fromDomain = slash === -1 ? rel : rel.slice(0, slash);
    const absFile = join(servicesRoot, rel);
    const source = readFileSync(absFile, 'utf8');
    const fileDir = dirname(absFile);
    for (const { specifier, typeOnly } of extractModuleReferences(source)) {
      if (typeOnly) {
        continue;
      }
      const target = resolveServiceTarget(specifier, fileDir, srcRoot);
      if (target === null) {
        continue;
      }
      if (target.domain === fromDomain) {
        continue;
      }
      if (!SERVICE_IMPL_RE.test(target.moduleName)) {
        continue;
      }
      violations.push({
        file: `services/${rel}`,
        fromDomain,
        toDomain: target.domain,
        specifier,
      });
    }
  }
  return violations;
}

describe('dependency-direction fence', () => {
  describe('positive cases (current tree is clean)', () => {
    it('runtime modules do not import back into services/ (real src)', () => {
      expect(findViolations(SRC, RUNTIME_DIRS)).toEqual([]);
    });

    it('runtime repositories / indexes do not import from services/ (real src)', () => {
      expect(findRepositoryIndexServiceImports(SRC, RUNTIME_DIRS)).toEqual([]);
    });

    it('application services do not import concrete impls across domains (real src)', () => {
      expect(findCrossServiceBusinessImports(SRC)).toEqual([]);
    });
  });

  describe('negative fixture: runtime -> services', () => {
    let fixtureRoot: string | undefined;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it('detects a planted runtime -> services import across import forms', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      mkdirSync(join(fixtureRoot, 'runtime'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'runtime', 'foo.ts'),
        [
          "import { x } from '../services/bar';",
          'export { y } from "../services/baz";',
          "const lazy = import('../services/qux');",
          "import { z } from '@moonshot-ai/agent-core/services';",
          '',
        ].join('\n'),
      );

      const violations = findViolations(fixtureRoot, ['runtime']);
      const specifiers = violations.map((v) => v.specifier);

      expect(specifiers).toContain('../services/bar');
      expect(specifiers).toContain('../services/baz');
      expect(specifiers).toContain('../services/qux');
      expect(specifiers).toContain('@moonshot-ai/agent-core/services');
      expect(violations.every((v) => v.file === 'runtime/foo.ts')).toBe(true);
    });
  });

  describe('negative fixture: repository / index -> services', () => {
    let fixtureRoot: string | undefined;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it('detects planted repository and index files importing from services/', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      mkdirSync(join(fixtureRoot, 'session'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'session', 'fooRepository.ts'),
        [
          "import { x } from '../services/bar';",
          "import type { y } from '../services/baz';",
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(fixtureRoot, 'session', 'fooIndex.ts'),
        ["import { z } from '@moonshot-ai/agent-core/services/qux';", ''].join('\n'),
      );
      // A non-repository/index runtime file importing services is out of scope
      // for THIS detector (it is caught by findViolations instead) and must not
      // be reported here.
      writeFileSync(
        join(fixtureRoot, 'session', 'helper.ts'),
        ["import { w } from '../services/bar';", ''].join('\n'),
      );

      const violations = findRepositoryIndexServiceImports(fixtureRoot, ['session']);
      const specifiersByFile = (file: string): string[] =>
        violations.filter((v) => v.file === file).map((v) => v.specifier);

      // Both the value and the type-only services imports are flagged: a type
      // dependency is still a layer violation for the persistence layer.
      expect(specifiersByFile('session/fooRepository.ts').sort()).toEqual([
        '../services/bar',
        '../services/baz',
      ]);
      expect(specifiersByFile('session/fooIndex.ts')).toEqual([
        '@moonshot-ai/agent-core/services/qux',
      ]);
      expect(specifiersByFile('session/helper.ts')).toEqual([]);
    });
  });

  describe('negative fixture: cross-service business import', () => {
    let fixtureRoot: string | undefined;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it('detects a planted concrete impl import across service domains', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      mkdirSync(join(fixtureRoot, 'services', 'foo'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'services', 'bar'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'services', 'baz'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'services', 'bar', 'barService.ts'), 'export class BarService {}\n');
      writeFileSync(join(fixtureRoot, 'services', 'baz', 'bazService.ts'), 'export class BazService {}\n');
      writeFileSync(
        join(fixtureRoot, 'services', 'foo', 'fooService.ts'),
        [
          // Concrete impl import from another domain -> flagged.
          "import { BarService } from '../bar/barService';",
          // Concrete impl via the bare package subpath -> flagged.
          "import { BazService } from '@moonshot-ai/agent-core/services/baz/bazService';",
          '',
        ].join('\n'),
      );

      const violations = findCrossServiceBusinessImports(fixtureRoot);
      const specifiers = violations.map((v) => v.specifier);

      expect(specifiers).toContain('../bar/barService');
      expect(specifiers).toContain('@moonshot-ai/agent-core/services/baz/bazService');
      expect(
        violations.every(
          (v) =>
            v.file === 'services/foo/fooService.ts' &&
            v.fromDomain === 'foo' &&
            (v.toDomain === 'bar' || v.toDomain === 'baz'),
        ),
      ).toBe(true);
    });

    it('does not flag type-only, contract, barrel, or same-domain imports', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      mkdirSync(join(fixtureRoot, 'services', 'foo'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'services', 'bar'), { recursive: true });
      writeFileSync(join(fixtureRoot, 'services', 'bar', 'barService.ts'), 'export class BarService {}\n');
      writeFileSync(join(fixtureRoot, 'services', 'bar', 'bar.ts'), 'export interface IBarService {}\n');
      writeFileSync(join(fixtureRoot, 'services', 'bar', 'index.ts'), 'export * from "./bar";\n');
      writeFileSync(join(fixtureRoot, 'services', 'foo', 'fooQueryService.ts'), 'export class FooQueryService {}\n');
      writeFileSync(
        join(fixtureRoot, 'services', 'foo', 'fooService.ts'),
        [
          // type-only import of a concrete impl -> allowed (not a business dependency).
          "import type { BarService } from '../bar/barService';",
          // inline `type` on the only binding -> allowed.
          "import { type IBarService } from '../bar/barService';",
          // contract import from `<domain>.ts` -> allowed.
          "import { IBarService } from '../bar/bar';",
          // domain barrel import (`index.ts`) -> allowed.
          "import { IBarService as IBarService2 } from '../bar';",
          // same-domain sibling impl import -> convention-only, NOT flagged here.
          "import { FooQueryService } from './fooQueryService';",
          '',
        ].join('\n'),
      );

      expect(findCrossServiceBusinessImports(fixtureRoot)).toEqual([]);
    });
  });
});
