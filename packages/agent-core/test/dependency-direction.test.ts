import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * di-v3 target-structure rules (FIXTURE-based until P2/P3 lands the layout):
 *
 *  4. `_utils/` ← `_base/` ← `domains/` — the di-v3 internal infrastructure
 *     layering. `_utils/` is the lowest layer and must NOT import `_base/` or
 *     any domain; `_base/` must NOT import any domain (importing `_utils/` is
 *     the allowed direction). See {@link findBaseUtilsViolations}.
 *  5. `agent-core/<domain>/` dirs don't import each other's impls — a domain A
 *     file must NOT value-import a CONCRETE impl (`<domainB>/<impl>Service.ts`)
 *     from another domain B (A ≠ B). Cross-domain access goes through the
 *     contract + `IServiceAccessor`. Type imports, contract imports
 *     (`<domainB>.ts`), and barrel imports (`<domainB>/index.ts`) are allowed.
 *     See {@link findCrossDomainImplImports}.
 *
 * The current `src/` tree has no `_base/` / `_utils/` / di-v3 `<domain>/` dirs
 * yet, so the real-tree positive cases for rules 4 and 5 are VACUOUSLY CLEAN
 * (0 violations) — the detectors simply have nothing to scan. Rule 4 scans
 * `_utils/` and `_base/` directly (absent → empty); rule 5 is gated on the
 * di-v3 infra markers (`_base/` / `_utils/`) being present (absent → dormant).
 * Both rules activate as di-v3 lands in P2/P3. The fixture cases below drive
 * the exact same detection logic against planted di-v3-shaped trees so the
 * positive and negative paths are exercised today.
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

// Bare package root used by the di-v3 cross-domain rule to recognise
// `@moonshot-ai/agent-core/<domain>/<impl>` specifiers.
const AGENT_CORE_BARE = '@moonshot-ai/agent-core';

// Top-level dirs under `src/` that are NOT di-v3 domains. `_base` / `_utils`
// are the di-v3 internal infrastructure layers (rule 4); the rest are
// cross-cutting infrastructure that is exempt from the domain-to-domain impl
// rule (rule 5). `services` is the pre-di-v3 facade and is excluded so the
// legacy tree never trips rule 5.
const DIV3_RESERVED_DIRS = [
  '_base',
  '_utils',
  'scope',
  'rpc',
  'config',
  'flags',
  'errors',
  'services',
] as const;

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

export interface BaseUtilsViolation {
  /** Path of the offending file, relative to the scanned `srcRoot`. */
  file: string;
  /** The module specifier that crosses the infrastructure layer boundary. */
  specifier: string;
  /** The lower infrastructure layer the offending file lives in. */
  layer: '_utils' | '_base';
  /** What was illegally imported: `_base` (only from `_utils`) or a domain. */
  target: '_base' | 'domain';
}

export interface CrossDomainViolation {
  /** Path of the offending file, relative to the scanned `srcRoot`. */
  file: string;
  /** di-v3 domain folder that owns the importing file. */
  fromDomain: string;
  /** di-v3 domain folder that owns the imported concrete impl. */
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

/**
 * List the immediate child directories of `srcRoot`. Used to discover the
 * di-v3 top-level domain dirs (everything except {@link DIV3_RESERVED_DIRS}).
 */
function listTopLevelDirs(srcRoot: string): string[] {
  return readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** di-v3 domain dirs = top-level dirs minus the reserved infrastructure set. */
function listDomainDirs(srcRoot: string): string[] {
  const reserved = new Set<string>(DIV3_RESERVED_DIRS);
  return listTopLevelDirs(srcRoot).filter((name) => !reserved.has(name));
}

/**
 * The di-v3 layout is considered active once its internal infrastructure
 * markers (`_base/` / `_utils/`) exist under `srcRoot`. Until then the current
 * tree has neither marker, so rule 5 (cross-domain impl) is dormant and its
 * real-tree case is vacuously clean.
 */
function isDiV3LayoutActive(srcRoot: string): boolean {
  return existsSync(join(srcRoot, '_base')) || existsSync(join(srcRoot, '_utils'));
}

interface TopLevelTarget {
  /** Top-level dir under `srcRoot` the specifier resolves into. */
  dir: string;
  /** Final path segment with any extension stripped (for impl-suffix checks). */
  moduleName: string;
}

/**
 * Resolve a module specifier to the top-level dir under `srcRoot` it points
 * into, or `null` when it does not point into a top-level dir's module (e.g.
 * a top-level file, a bare package root, or an external package). Handles both
 * relative (`../<dir>/<module>`) and bare
 * (`@moonshot-ai/agent-core/<dir>/<module>`) specifiers.
 */
function resolveTopLevelTarget(
  specifier: string,
  fileDir: string,
  srcRoot: string,
): TopLevelTarget | null {
  const toTarget = (rest: string): TopLevelTarget | null => {
    const parts = rest.split('/').filter((part) => part.length > 0);
    if (parts.length < 2) {
      // Points at a top-level dir root (barrel) or a top-level file — not a
      // module inside a top-level dir.
      return null;
    }
    const [dir, ...restParts] = parts;
    const leaf = restParts[restParts.length - 1];
    if (dir === undefined || leaf === undefined) {
      return null;
    }
    const moduleName = leaf.replace(/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, '');
    return { dir, moduleName };
  };

  if (specifier.startsWith('.')) {
    const resolved = normalize(join(fileDir, specifier));
    const root = normalize(srcRoot);
    if (!resolved.startsWith(`${root}/`)) {
      return null;
    }
    return toTarget(resolved.slice(root.length + 1));
  }

  const barePrefix = `${AGENT_CORE_BARE}/`;
  if (specifier.startsWith(barePrefix)) {
    return toTarget(specifier.slice(barePrefix.length));
  }

  return null;
}

/**
 * Rule 4 (di-v3) — `_utils/` ← `_base/` ← `domains/`. Scans the `_utils/` and
 * `_base/` infrastructure layers and flags imports that point up the layering:
 *  - `_utils/` must NOT import `_base/` or any domain;
 *  - `_base/` must NOT import any domain (importing `_utils/` is allowed).
 *
 * Every import form is flagged, including `import type`: a type dependency is
 * still a layer violation for infrastructure (it would prevent `_utils/` from
 * being extracted independently of `_base/`).
 *
 * Pure and exported so both the (vacuously clean) real-tree case and the
 * planted fixtures drive the exact same detection logic.
 */
export function findBaseUtilsViolations(srcRoot: string): BaseUtilsViolation[] {
  const violations: BaseUtilsViolation[] = [];
  const domainDirs = new Set(listDomainDirs(srcRoot));

  const scanLayer = (layer: '_utils' | '_base', forbidBase: boolean): void => {
    const absDir = join(srcRoot, layer);
    const files = globSync('**/*.ts', { cwd: absDir }).map((file) => file.split('\\').join('/'));
    for (const rel of files) {
      const absFile = join(absDir, rel);
      const source = readFileSync(absFile, 'utf8');
      const fileDir = dirname(absFile);
      for (const specifier of extractSpecifiers(source)) {
        const target = resolveTopLevelTarget(specifier, fileDir, srcRoot);
        if (target === null) {
          continue;
        }
        if (forbidBase && target.dir === '_base') {
          violations.push({ file: `${layer}/${rel}`, specifier, layer, target: '_base' });
        } else if (domainDirs.has(target.dir)) {
          violations.push({ file: `${layer}/${rel}`, specifier, layer, target: 'domain' });
        }
      }
    }
  };

  scanLayer('_utils', true);
  scanLayer('_base', false);
  return violations;
}

/**
 * Rule 5 (di-v3) — `agent-core/<domain>/` dirs don't import each other's
 * impls. A file in domain A must NOT value-import a CONCRETE impl
 * (`<domainB>/<impl>Service.ts`) from another domain B (A ≠ B). Type-only
 * imports, contract imports (`<domainB>.ts`), and barrel imports
 * (`<domainB>/index.ts`) are allowed. Same-domain imports are not flagged.
 *
 * Dormant until the di-v3 layout is active (see {@link isDiV3LayoutActive});
 * on the current tree (no `_base/`/`_utils/`) it returns no violations, so the
 * real-tree case is vacuously clean.
 */
export function findCrossDomainImplImports(srcRoot: string): CrossDomainViolation[] {
  if (!isDiV3LayoutActive(srcRoot)) {
    return [];
  }
  const domainDirs = listDomainDirs(srcRoot);
  const domainSet = new Set(domainDirs);
  const violations: CrossDomainViolation[] = [];
  for (const fromDomain of domainDirs) {
    const absDir = join(srcRoot, fromDomain);
    const files = globSync('**/*.ts', { cwd: absDir }).map((file) => file.split('\\').join('/'));
    for (const rel of files) {
      const absFile = join(absDir, rel);
      const source = readFileSync(absFile, 'utf8');
      const fileDir = dirname(absFile);
      for (const { specifier, typeOnly } of extractModuleReferences(source)) {
        if (typeOnly) {
          continue;
        }
        const target = resolveTopLevelTarget(specifier, fileDir, srcRoot);
        if (target === null) {
          continue;
        }
        if (!domainSet.has(target.dir)) {
          continue;
        }
        if (target.dir === fromDomain) {
          continue;
        }
        if (!SERVICE_IMPL_RE.test(target.moduleName)) {
          continue;
        }
        violations.push({
          file: `${fromDomain}/${rel}`,
          fromDomain,
          toDomain: target.dir,
          specifier,
        });
      }
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

    it('di-v3 base/utils layering is vacuously clean (no _base/_utils dirs yet)', () => {
      expect(findBaseUtilsViolations(SRC)).toEqual([]);
    });

    it('di-v3 cross-domain impl fence is vacuously clean (di-v3 layout not active yet)', () => {
      expect(findCrossDomainImplImports(SRC)).toEqual([]);
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

  describe('negative fixture: di-v3 _utils / _base layering', () => {
    let fixtureRoot: string | undefined;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it('detects _utils importing _base or a domain (including type-only)', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      mkdirSync(join(fixtureRoot, '_utils'), { recursive: true });
      mkdirSync(join(fixtureRoot, '_base'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'loop'), { recursive: true });
      writeFileSync(join(fixtureRoot, '_base', 'event.ts'), 'export class Emitter {}\n');
      writeFileSync(join(fixtureRoot, '_base', 'types.ts'), 'export interface BaseType {}\n');
      writeFileSync(join(fixtureRoot, 'loop', 'turnService.ts'), 'export class TurnService {}\n');
      writeFileSync(
        join(fixtureRoot, '_utils', 'helper.ts'),
        [
          // _utils -> _base value import -> flagged.
          "import { Emitter } from '../_base/event';",
          // _utils -> _base type-only import -> flagged (still a layer violation).
          "import type { BaseType } from '../_base/types';",
          // _utils -> domain import -> flagged.
          "import { TurnService } from '../loop/turnService';",
          '',
        ].join('\n'),
      );

      const violations = findBaseUtilsViolations(fixtureRoot);
      const specifiers = violations.map((v) => v.specifier);

      expect(specifiers).toContain('../_base/event');
      expect(specifiers).toContain('../_base/types');
      expect(specifiers).toContain('../loop/turnService');
      expect(violations.every((v) => v.layer === '_utils' && v.file === '_utils/helper.ts')).toBe(true);
    });

    it('detects _base importing a domain but allows _base importing _utils', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      mkdirSync(join(fixtureRoot, '_utils'), { recursive: true });
      mkdirSync(join(fixtureRoot, '_base'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'loop'), { recursive: true });
      writeFileSync(join(fixtureRoot, '_utils', 'helper.ts'), 'export const h = 1;\n');
      writeFileSync(join(fixtureRoot, 'loop', 'turnService.ts'), 'export class TurnService {}\n');
      writeFileSync(
        join(fixtureRoot, '_base', 'logger.ts'),
        [
          // _base -> _utils -> allowed direction, NOT flagged.
          "import { h } from '../_utils/helper';",
          // _base -> domain -> flagged.
          "import { TurnService } from '../loop/turnService';",
          '',
        ].join('\n'),
      );

      const violations = findBaseUtilsViolations(fixtureRoot);
      const specifiers = violations.map((v) => v.specifier);

      expect(specifiers).toContain('../loop/turnService');
      expect(specifiers).not.toContain('../_utils/helper');
      expect(
        violations.every(
          (v) => v.layer === '_base' && v.target === 'domain' && v.file === '_base/logger.ts',
        ),
      ).toBe(true);
    });
  });

  describe('positive fixture: di-v3 _utils / _base layering compliant', () => {
    let fixtureRoot: string | undefined;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it('does not flag a compliant base/utils structure', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      mkdirSync(join(fixtureRoot, '_utils'), { recursive: true });
      mkdirSync(join(fixtureRoot, '_base'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'loop'), { recursive: true });
      // _utils imports nothing internal.
      writeFileSync(join(fixtureRoot, '_utils', 'helper.ts'), 'export const h = 1;\n');
      // _base only imports _utils (allowed direction).
      writeFileSync(
        join(fixtureRoot, '_base', 'logger.ts'),
        ["import { h } from '../_utils/helper';", ''].join('\n'),
      );
      // Domains may freely import _base and _utils (the allowed direction);
      // findBaseUtilsViolations only scans _utils/_base, so these are never checked.
      writeFileSync(
        join(fixtureRoot, 'loop', 'turnService.ts'),
        [
          "import { h } from '../_utils/helper';",
          "import { Logger } from '../_base/logger';",
          '',
        ].join('\n'),
      );

      expect(findBaseUtilsViolations(fixtureRoot)).toEqual([]);
    });
  });

  describe('negative fixture: di-v3 cross-domain impl import', () => {
    let fixtureRoot: string | undefined;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it('detects a domain importing another domain concrete impl', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      // Plant the di-v3 infra marker so the cross-domain rule activates.
      mkdirSync(join(fixtureRoot, '_base'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'loop'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'kosong'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'kosong', 'chatProviderService.ts'),
        'export class ChatProviderService {}\n',
      );
      writeFileSync(join(fixtureRoot, 'kosong', 'tokenizerService.ts'), 'export class TokenizerService {}\n');
      writeFileSync(
        join(fixtureRoot, 'loop', 'turnService.ts'),
        [
          // Cross-domain concrete impl import via relative specifier -> flagged.
          "import { ChatProviderService } from '../kosong/chatProviderService';",
          // Cross-domain concrete impl import via bare package subpath -> flagged.
          "import { TokenizerService } from '@moonshot-ai/agent-core/kosong/tokenizerService';",
          '',
        ].join('\n'),
      );

      const violations = findCrossDomainImplImports(fixtureRoot);
      const specifiers = violations.map((v) => v.specifier);

      expect(specifiers).toContain('../kosong/chatProviderService');
      expect(specifiers).toContain('@moonshot-ai/agent-core/kosong/tokenizerService');
      expect(
        violations.every(
          (v) =>
            v.file === 'loop/turnService.ts' && v.fromDomain === 'loop' && v.toDomain === 'kosong',
        ),
      ).toBe(true);
    });
  });

  describe('positive fixture: di-v3 cross-domain impl compliant', () => {
    let fixtureRoot: string | undefined;

    afterEach(() => {
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = undefined;
      }
    });

    it('does not flag type-only, contract, barrel, or same-domain imports across domains', () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'agent-core-dep-fence-'));
      // Plant the di-v3 infra marker so the cross-domain rule activates.
      mkdirSync(join(fixtureRoot, '_base'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'loop'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'kosong'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'kosong', 'chatProviderService.ts'),
        'export class ChatProviderService {}\n',
      );
      writeFileSync(join(fixtureRoot, 'kosong', 'chatProvider.ts'), 'export interface IChatProvider {}\n');
      writeFileSync(join(fixtureRoot, 'kosong', 'index.ts'), 'export * from "./chatProvider";\n');
      writeFileSync(join(fixtureRoot, 'loop', 'toolService.ts'), 'export class ToolService {}\n');
      writeFileSync(
        join(fixtureRoot, 'loop', 'turnService.ts'),
        [
          // type-only import of a concrete impl -> allowed.
          "import type { ChatProviderService } from '../kosong/chatProviderService';",
          // inline `type` on the only binding -> allowed.
          "import { type IChatProvider } from '../kosong/chatProviderService';",
          // contract import from `<domain>.ts` -> allowed.
          "import { IChatProvider } from '../kosong/chatProvider';",
          // domain barrel import (`index.ts`) -> allowed.
          "import { IChatProvider as IChatProvider2 } from '../kosong';",
          // explicit barrel import -> allowed.
          "import { IChatProvider as IChatProvider3 } from '../kosong/index';",
          // same-domain sibling impl import -> allowed.
          "import { ToolService } from './toolService';",
          '',
        ].join('\n'),
      );

      expect(findCrossDomainImplImports(fixtureRoot)).toEqual([]);
    });
  });
});
