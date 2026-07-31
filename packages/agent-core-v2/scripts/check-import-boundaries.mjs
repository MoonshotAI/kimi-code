#!/usr/bin/env node
/**
 * Import-boundary checker for `agent-core-v2`.
 *
 * Enforces two rules over `packages/agent-core-v2/src/**` (and the v1-import
 * ban over `test/**` too):
 *
 *  1. **No v1 imports** — v2 must never `import '@moonshot-ai/agent-core'`
 *     (or any subpath). v2 ports logic; it never depends on v1.
 *  2. **Kosong layering** — the `src/kosong/{contract,protocol,provider,model}`
 *     subtree has strict internal rules:
 *       - internal order: contract(L0) ← protocol(L1) ← provider/model(L2)
 *         ← catalog(L3); a lower layer never imports a higher one (so L1
 *         protocol never sees L2 — trait contexts carry only `providerId`).
 *       - peer rule: `model` may import `provider`, never the reverse.
 *       - purity: `contract` imports no other domain (only `_base` helpers)
 *         and no external package at all (no SDKs, not even types);
 *         `protocol` imports only `_base` + `contract` and no wire SDK.
 *       - `provider/bases/` sub-boundary: base implementation files must not
 *         import the registries (`protocolBase`, `protocolAdapterRegistry`),
 *         `providerDefinition`, or any `*.contrib.ts` module. The
 *         registration side lives in `*.contrib.ts` and in each base
 *         directory's `index.ts` barrel (import = registration); both are
 *         exempt.
 *     Kosong directories that do not exist yet are skipped silently (later
 *     refactor phases add them).
 *
 * Intra-package relative imports and `#/`-alias imports are resolved against
 * `src/`. Sibling packages (`@moonshot-ai/*` other than v1) and third-party
 * imports are out of scope (except for the kosong purity bans above).
 *
 * Run: `node scripts/check-import-boundaries.mjs`. Exits non-zero on violation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
const TEST_ROOT = join(PKG_ROOT, 'test');

const V1_PACKAGE = '@moonshot-ai/agent-core';

/**
 * Scope directories introduced by the `src/{scope}/{domain}` layout. A path's
 * first segment is a scope tier, not a domain; the domain is the next segment.
 */
const SCOPE_DIRS = new Set(['app', 'workspace', 'session', 'agent', 'persistence', 'os', 'kosong']);

/**
 * Two-level scope directories: `persistence` and `os` use `{scope}/{tier}`
 * (e.g. `persistence/interface`, `os/backends`) as the domain key; `kosong`
 * uses `{scope}/{layer}` (e.g. `kosong/contract`) the same way.
 */
const TWO_LEVEL_SCOPES = new Set(['persistence', 'os', 'kosong']);

/**
 * Kosong-internal layer order: contract ← protocol ← provider/model.
 * A lower layer never imports a higher one; `model` → `provider`
 * is the only allowed peer edge. Keyed by the segment under `src/kosong/`.
 */
const KOSONG_LAYER = new Map([
  ['contract', 0],
  ['protocol', 1],
  ['provider', 2],
  ['model', 2],
]);

/**
 * Kosong is a pure provider/model abstraction layer: NO kosong subdomain may
 * import another v2 domain outside kosong itself — only `_base` utilities
 * are allowed. (`protocol` additionally sees `kosong/contract`, handled by
 * the internal-layer rule above.) Config persistence, OAuth tokens, events,
 * and discovery orchestration all live in the upper `app/kosongConfig`
 * wrapper — kosong must never reach up to them.
 */
const KOSONG_BASE_ONLY_SUBDOMAINS = new Set(['contract', 'protocol', 'provider', 'model']);

/**
 * Wire SDK packages the pure kosong layers must never import — not even
 * types. `contract` in fact imports no external package at all; this list
 * covers the SDK ban for `protocol`.
 */
const KOSONG_BANNED_SDK_PACKAGES = ['@anthropic-ai/sdk', '@google/genai', 'openai'];

/**
 * Parse an absolute path under `src/kosong/` into its subdomain info.
 * Returns `undefined` for paths outside `src/kosong/`.
 * @param {string} absPath
 * @returns {{ sub: string | undefined, inBases: boolean, isContrib: boolean, isIndex: boolean } | undefined}
 */
function kosongInfoOf(absPath) {
  const rel = relative(SRC_ROOT, absPath);
  if (rel.startsWith('..') || rel === '') return undefined;
  const segments = rel.split(/[\\/]/);
  if (segments[0] !== 'kosong') return undefined;
  const sub = segments[1];
  const last = segments[segments.length - 1] ?? '';
  return {
    // A file directly under `src/kosong/` has no subdomain.
    sub: sub === undefined || sub.endsWith('.ts') ? undefined : sub,
    inBases: sub === 'provider' && segments[2] === 'bases',
    isContrib: last.endsWith('.contrib.ts'),
    isIndex: last === 'index.ts',
  };
}

/**
 * Whether an import target is off-limits to base implementation files under
 * `kosong/provider/bases/` (everything except `*.contrib.ts` and the
 * registration `index.ts` barrels): the base registry
 * (`kosong/protocol/protocolBase`), the adapter registry
 * (`kosong/provider/protocolAdapterRegistry`), the provider-definition
 * registry (`kosong/provider/providerDefinition`), or any contrib
 * side-effect module. Matches extensionless specifiers too.
 * @param {string} targetAbs
 */
function isKosongBasesBannedTarget(targetAbs) {
  const rel = relative(SRC_ROOT, targetAbs).split(/[\\/]/).join('/');
  const stripped = rel.endsWith('.ts') ? rel.slice(0, -'.ts'.length) : rel;
  if (stripped.endsWith('.contrib')) return true;
  return (
    /(^|\/)kosong\/provider\/providerDefinition$/.test(stripped) ||
    /(^|\/)kosong\/provider\/protocolAdapterRegistry$/.test(stripped) ||
    /(^|\/)kosong\/protocol\/protocolBase$/.test(stripped)
  );
}

/**
 * Resolve a `src/`-relative path to its domain, skipping the scope tier when
 * present. Returns `undefined` for top-level root files (e.g. the package
 * barrel `index.ts`, or the `errors`/`hooks` facades).
 * @param {string} rel
 */
function domainFromRel(rel) {
  const segments = rel.split(/[\\/]/);
  if (TWO_LEVEL_SCOPES.has(segments[0])) {
    // `src/{persistence|os}/{interface|backends}/…`
    return segments[1] ? `${segments[0]}/${segments[1]}` : segments[0];
  }
  if (SCOPE_DIRS.has(segments[0])) {
    if (segments.length === 2 && segments[1]?.endsWith('.ts')) return segments[0];
    // `src/{scope}/{domain}/…`
    if (segments[0] === 'agent' && segments[1] === 'task') return 'agentTask';
    if (segments[0] === 'agent' && segments[1] === 'plugin') return 'agentPlugin';
    return segments[1];
  }
  return segments[0];
}

/**
 * Determine the v2 domain for an *import target* absolute path. A target may
 * resolve straight to a domain directory — e.g. the bare domain import
 * `#/turn` resolves to `src/agent/turn`, whose domain is `turn`.
 * @param {string} targetAbs
 */
function targetDomainOf(targetAbs) {
  const rel = relative(SRC_ROOT, targetAbs);
  if (rel.startsWith('..') || rel === '') return undefined;
  return domainFromRel(rel);
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

// Matches: import ... from 'x' | export ... from 'x' | import('x') | require('x')
const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * @typedef {{ file: string, line: number, message: string }} Violation
 */

/**
 * Check source text for boundary violations. `absFile` is used only to
 * resolve relative specifiers and determine the source location; the file
 * need not exist on disk (handy for tests).
 * @param {string} source
 * @param {string} absFile
 * @returns {Violation[]}
 */
export function checkSource(source, absFile) {
  const violations = [];
  const inSrc = !relative(SRC_ROOT, absFile).startsWith('..');

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

    // Rule 2: kosong subtree (production code only).
    if (!inSrc) continue;
    const targetAbs = resolveIntraV2(specifier, absFile);
    const sourceKosong = kosongInfoOf(absFile);
    if (sourceKosong === undefined) continue;

    // Rule 2a: kosong purity bans on external packages. The L0 contract
    // imports no external package at all (no SDKs, not even types); the L1
    // protocol layer is SDK-free but may use general-purpose packages.
    if (targetAbs === undefined) {
      if (sourceKosong.sub === 'contract') {
        violations.push({
          file: absFile,
          line,
          message: `kosong/contract must not import external package '${specifier}' — the L0 wire contract is pure (no SDK, no I/O, no third-party dependencies)`,
        });
      } else if (
        sourceKosong.sub === 'protocol' &&
        KOSONG_BANNED_SDK_PACKAGES.some(
          (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
        )
      ) {
        violations.push({
          file: absFile,
          line,
          message: `kosong/protocol must not import wire SDK '${specifier}' — L1 trait interfaces are SDK-free`,
        });
      }
      continue;
    }

    // Rule 2b: kosong-internal layering. Runs even for same-domain imports
    // because the provider/bases sub-boundary also bans same-domain targets
    // (registries and contrib modules live beside the bases).
    const targetKosong = kosongInfoOf(targetAbs);
    if (targetKosong !== undefined) {
      const sourceKosongLayer = KOSONG_LAYER.get(sourceKosong.sub);
      const targetKosongLayer = KOSONG_LAYER.get(targetKosong.sub);
      if (sourceKosongLayer !== undefined && targetKosongLayer !== undefined) {
        if (targetKosongLayer > sourceKosongLayer) {
          violations.push({
            file: absFile,
            line,
            message: `kosong layer violation: 'kosong/${sourceKosong.sub}' (L${sourceKosongLayer}) imports 'kosong/${targetKosong.sub}' (L${targetKosongLayer}) via '${specifier}' — kosong layers are contract(L0) ← protocol(L1) ← provider/model(L2)`,
          });
        } else if (sourceKosong.sub === 'provider' && targetKosong.sub === 'model') {
          violations.push({
            file: absFile,
            line,
            message: `kosong peer violation: 'kosong/provider' must not import 'kosong/model' via '${specifier}' — the peer dependency runs model → provider only`,
          });
        }
      }
      if (
        sourceKosong.inBases &&
        !sourceKosong.isContrib &&
        !sourceKosong.isIndex &&
        isKosongBasesBannedTarget(targetAbs)
      ) {
        violations.push({
          file: absFile,
          line,
          message: `kosong bases boundary: base implementation files under 'kosong/provider/bases' must not import registries (protocolBase/protocolAdapterRegistry), providerDefinition, or contrib modules (via '${specifier}') — registration lives in *.contrib.ts and the directory index.ts`,
        });
      }
      continue;
    }

    // Rule 2c: outside the kosong subtree, kosong code may only depend on
    // `_base` utilities (`protocol` additionally sees `kosong/contract`,
    // handled by Rule 2b above). This is what keeps kosong a pure
    // abstraction layer with no upward dependencies.
    if (KOSONG_BASE_ONLY_SUBDOMAINS.has(sourceKosong.sub)) {
      const targetDomain = targetDomainOf(targetAbs);
      if (targetDomain !== '_base') {
        violations.push({
          file: absFile,
          line,
          message: `'kosong/${sourceKosong.sub}' must not import domain '${targetDomain ?? specifier}' via '${specifier}' — kosong is a pure abstraction layer: only _base utilities are allowed outside the kosong subtree (persistence/OAuth/discovery live in app/kosongConfig)`,
        });
      }
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
    console.log(`check-import-boundaries: OK (${files.length} files)`);
    return 0;
  }
  for (const v of violations) {
    console.error(`${relative(PKG_ROOT, v.file)}:${v.line}: ${v.message}`);
  }
  console.error(`\ncheck-import-boundaries: ${violations.length} violation(s)`);
  return 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main());
}
