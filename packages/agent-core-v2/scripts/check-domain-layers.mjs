#!/usr/bin/env node
/**
 * Domain-layer import boundary checker for `agent-core-v2`.
 *
 * Enforces two rules over `packages/agent-core-v2/src/**` (and the v1-import
 * ban over `test/**` too):
 *
 *  1. **No v1 imports** — v2 must never `import '@moonshot-ai/agent-core'`
 *     (or any subpath). v2 ports logic; it never depends on v1.
 *  2. **Domain layering** — a domain at layer L may only import domains at
 *     layer `<= L`. Lower layers must not reach upward. See
 *     `plan/PLAN.md` §3 / §5 for the layer table.
 *
 * Intra-package relative imports and `#/`-alias imports are resolved to a
 * domain by the first path segment under `src/`. Sibling packages
 * (`@moonshot-ai/*` other than v1) and third-party imports are out of scope.
 *
 * Run: `node scripts/check-domain-layers.mjs`. Exits non-zero on violation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
const TEST_ROOT = join(PKG_ROOT, 'test');

/**
 * Domain → layer. A domain may only import domains at its own layer or lower.
 * Keep in sync with `plan/PLAN.md` §3. Domains not listed here that appear
 * under `src/` are reported so the table stays current.
 */
const DOMAIN_LAYER = new Map([
  // L0 — base infrastructure
  ['_base', 0],
  // L1 — abstraction bridges
  ['log', 1],
  ['telemetry', 1],
  ['environment', 1],
  ['kaos', 1],
  ['kosong', 1],
  // L2 — data
  ['records', 2],
  ['config', 2],
  // L3 — registries
  ['tool', 3],
  ['skill', 3],
  ['permission', 3],
  ['flag', 3],
  // L4 — agent behaviour
  ['context', 4],
  ['message', 4],
  ['turn', 4],
  ['injection', 4],
  ['compaction', 4],
  ['plan', 4],
  ['goal', 4],
  ['swarm', 4],
  ['usage', 4],
  ['tooldedup', 4],
  // L5 — async lifecycle
  ['background', 5],
  ['mcp', 5],
  ['cron', 5],
  // L6 — coordination
  ['agent-lifecycle', 6],
  ['session-context', 6],
  ['session-activity', 6],
  ['session', 6],
  ['hooks', 6],
  // L7 — boundary
  ['event', 7],
  ['approval', 7],
  ['question', 7],
  ['gateway', 7],
  // Cross-cutting capabilities (depend on L1; consumed by upper layers).
  ['terminal', 2],
  ['fs', 2],
  ['workspace', 2],
  ['filestore', 2],
  ['auth', 2],
]);

const V1_PACKAGE = '@moonshot-ai/agent-core';

/**
 * Deliberate, documented exceptions to the strict low→high layering rule.
 * Each entry is `[fromDomain, toDomain]`.
 *
 * These are *real* dependencies taken from `plan/overview.md` §2 (Domain ×
 * Scope table). They are "upward" only by the coarse L1–L7 numbering; the
 * plan's parent–child Scope mechanism (handles) is the intended long-term
 * shape for several of them. They are surfaced here (and in the dependency
 * report) for review rather than hidden.
 *
 *  - `kosong>config`        : model catalog reads its config section (PLAN §Dep graph).
 *  - `permission>approval`  : permission(Agent) requests approval(Session broker).
 *  - `skill>turn`           : skill activate starts a turn (same Agent scope intent).
 *  - `turn>agent-lifecycle` : turn cancels sub-agents via lifecycle handle.
 *  - `swarm>agent-lifecycle`: swarm spawns/manages sub-agents.
 *  - `background>agent-lifecycle`: background agent-tasks spawn sub-agents.
 *  - `cron>agent-lifecycle` : cron coordinator steers the main agent.
 *  - `cron>session-context` : cron needs sessionId.
 *  - `cron>session-activity`: cron scheduler gates on session idle.
 *  - `session>event`        : session facade publishes status events.
 */
const ALLOWED_EXCEPTIONS = new Set([
  'kosong>config',
  'permission>approval',
  'skill>turn',
  'turn>agent-lifecycle',
  'swarm>agent-lifecycle',
  'background>agent-lifecycle',
  'cron>agent-lifecycle',
  'cron>session-context',
  'cron>session-activity',
  'session>event',
]);

// Matches: import ... from 'x' | export ... from 'x' | import('x') | require('x')
const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * @typedef {{ file: string, line: number, message: string }} Violation
 */

/**
 * Determine the v2 domain (first `src/`-relative path segment) for an
 * absolute file path. Returns `undefined` for files outside `src/`.
 * @param {string} absPath
 */
function domainOf(absPath) {
  const rel = relative(SRC_ROOT, absPath);
  if (rel.startsWith('..') || rel === '') return undefined;
  const segments = rel.split(/[\\/]/);
  // Top-level `src/*.ts` files (e.g. the package barrel `index.ts`) are not
  // domains — they re-export other domains and are exempt from layering.
  if (segments.length < 2) return undefined;
  return segments[0];
}

/**
 * Resolve an import specifier to an absolute v2 `src/` path, or `undefined`
 * when the specifier is not an intra-v2 import.
 * @param {string} specifier
 * @param {string} fromFile absolute path of the importing file
 */
function resolveIntraV2(specifier, fromFile) {
  if (specifier.startsWith('#/')) {
    return join(SRC_ROOT, specifier.slice(2));
  }
  if (specifier.startsWith('.')) {
    return resolve(dirname(fromFile), specifier);
  }
  return undefined;
}

/**
 * Check source text for boundary violations. `absFile` is used only to
 * resolve relative specifiers and determine the source domain; the file need
 * not exist on disk (handy for tests).
 * @param {string} source
 * @param {string} absFile
 * @returns {Violation[]}
 */
export function checkSource(source, absFile) {
  const violations = [];
  const inSrc = !relative(SRC_ROOT, absFile).startsWith('..');
  const sourceDomain = inSrc ? domainOf(absFile) : undefined;
  const sourceLayer = sourceDomain === undefined ? undefined : DOMAIN_LAYER.get(sourceDomain);

  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const line = source.slice(0, match.index).split('\n').length;

    // Rule 1: v2 must not import v1.
    if (specifier === V1_PACKAGE || specifier.startsWith(`${V1_PACKAGE}/`)) {
      violations.push({
        file: absFile,
        line,
        message: `v2 must not import v1 (${specifier})`,
      });
      continue;
    }

    // Rule 2: domain layering (production code only).
    if (!inSrc) continue;
    if (sourceDomain === undefined) continue; // top-level barrel / non-domain file
    const targetAbs = resolveIntraV2(specifier, absFile);
    if (targetAbs === undefined) continue;
    const targetDomain = domainOf(targetAbs);
    if (targetDomain === undefined) continue;
    if (targetDomain === sourceDomain) continue; // same domain is always fine

    const targetLayer = DOMAIN_LAYER.get(targetDomain);
    if (sourceLayer === undefined) {
      violations.push({
        file: absFile,
        line,
        message: `source domain '${sourceDomain}' is not registered in DOMAIN_LAYER`,
      });
      continue;
    }
    if (targetLayer === undefined) {
      violations.push({
        file: absFile,
        line,
        message: `target domain '${targetDomain}' (imported as '${specifier}') is not registered in DOMAIN_LAYER`,
      });
      continue;
    }
    if (targetLayer > sourceLayer) {
      if (ALLOWED_EXCEPTIONS.has(`${sourceDomain}>${targetDomain}`)) continue;
      violations.push({
        file: absFile,
        line,
        message: `layer violation: '${sourceDomain}' (L${sourceLayer}) imports '${targetDomain}' (L${targetLayer}) via '${specifier}' — lower layers must not import higher layers`,
      });
    }
  }

  return violations;
}

/**
 * Check a single source file for boundary violations.
 * @param {string} absFile
 * @returns {Violation[]}
 */
export function checkFile(absFile) {
  return checkSource(readFileSync(absFile, 'utf8'), absFile);
}

function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (abs.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function main() {
  const files = [...walk(SRC_ROOT), ...walk(TEST_ROOT)];
  const violations = files.flatMap((f) => checkFile(f));
  if (violations.length === 0) {
    console.log(`check-domain-layers: OK (${files.length} files)`);
    return 0;
  }
  for (const v of violations) {
    console.error(`${relative(PKG_ROOT, v.file)}:${v.line}: ${v.message}`);
  }
  console.error(`\ncheck-domain-layers: ${violations.length} violation(s)`);
  return 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main());
}
