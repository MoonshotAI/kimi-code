import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Dependency-direction fence for agent-core.
 *
 * Pins the rule from `packages/agent-core/src/services/AGENTS.md:8-13`:
 * `services/` is the "upper facade" layer. It may depend on the runtime
 * (`rpc/`, `session/`, `agent/`, `di/`, …), but the runtime must NOT import
 * back into `services/`.
 *
 * This guard scans the runtime subtrees and fails if any module specifier
 * resolves into `src/services` — whether via a relative path
 * (`../services/x`, `../../services/y`) or the bare package subpath
 * (`@moonshot-ai/agent-core/services`). A planted fixture proves the
 * detector actually fires; the positive case pins the current (clean) tree.
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

export interface DependencyViolation {
  /** Path of the offending file, relative to the scanned `srcRoot`. */
  file: string;
  /** The module specifier that points into `services/`. */
  specifier: string;
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

describe('dependency-direction fence', () => {
  it('runtime modules do not import back into services/ (real src)', () => {
    expect(findViolations(SRC, RUNTIME_DIRS)).toEqual([]);
  });

  describe('negative fixture', () => {
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
});
