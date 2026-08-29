#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
const TEST_ROOT = join(PKG_ROOT, 'test');

const V1_PACKAGE = '@moonshot-ai/agent-core';
const SELF_PACKAGE_PREFIX = '@moonshot-ai/agent-core-v2/';

const SCOPE_DIRS = new Set(['app', 'workspace', 'session', 'agent', 'persistence', 'os', 'kosong']);

const TWO_LEVEL_SCOPES = new Set(['persistence', 'os', 'kosong']);

const KOSONG_LAYER = new Map([
  ['contract', 0],
  ['protocol', 1],
  ['provider', 2],
  ['model', 2],
]);

const KOSONG_BASE_ONLY_SUBDOMAINS = new Set(['contract', 'protocol', 'provider', 'model']);

const KOSONG_ALLOWED_VOCABULARY = new Set(['app/scopes']);

const KOSONG_BANNED_SDK_PACKAGES = ['@anthropic-ai/sdk', '@google/genai', 'openai'];

function kosongInfoOf(absPath) {
  const rel = relative(SRC_ROOT, absPath);
  if (rel.startsWith('..') || rel === '') return undefined;
  const segments = rel.split(/[\\/]/);
  if (segments[0] !== 'kosong') return undefined;
  const sub = segments[1];
  const last = segments[segments.length - 1] ?? '';
  return {
    sub: sub === undefined || sub.endsWith('.ts') ? undefined : sub,
    inBases: sub === 'provider' && segments[2] === 'bases',
    isContrib: last.endsWith('.contrib.ts'),
    isIndex: last === 'index.ts',
  };
}

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

function domainFromRel(rel) {
  const segments = rel.split(/[\\/]/);
  if (TWO_LEVEL_SCOPES.has(segments[0])) {
    return segments[1] ? `${segments[0]}/${segments[1]}` : segments[0];
  }
  if (SCOPE_DIRS.has(segments[0])) {
    if (segments.length === 2 && segments[1]?.endsWith('.ts')) return segments[0];
    if (segments[0] === 'agent' && segments[1] === 'task') return 'agentTask';
    if (segments[0] === 'agent' && segments[1] === 'plugin') return 'agentPlugin';
    return segments[1];
  }
  return segments[0];
}

function targetDomainOf(targetAbs) {
  const rel = relative(SRC_ROOT, targetAbs);
  if (rel.startsWith('..') || rel === '') return undefined;
  return domainFromRel(rel);
}

function resolveIntraV2(specifier, fromFile) {
  if (specifier.startsWith('#/')) {
    return join(SRC_ROOT, specifier.slice(2));
  }
  if (specifier.startsWith(SELF_PACKAGE_PREFIX)) {
    return join(SRC_ROOT, specifier.slice(SELF_PACKAGE_PREFIX.length));
  }
  if (specifier.startsWith('.')) {
    return resolve(dirname(fromFile), specifier);
  }
  return undefined;
}

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function checkSource(source, absFile) {
  const violations = [];
  const inSrc = !relative(SRC_ROOT, absFile).startsWith('..');

  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const line = source.slice(0, match.index).split('\n').length;

    if (specifier === V1_PACKAGE || specifier.startsWith(`${V1_PACKAGE}/`)) {
      violations.push({
        file: absFile,
        line,
        message: `v2 must not import v1 (${specifier})`,
      });
      continue;
    }

    if (!inSrc) continue;
    const targetAbs = resolveIntraV2(specifier, absFile);
    const sourceKosong = kosongInfoOf(absFile);
    if (sourceKosong === undefined) continue;

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

    if (KOSONG_BASE_ONLY_SUBDOMAINS.has(sourceKosong.sub)) {
      const targetDomain = targetDomainOf(targetAbs);
      const targetRel = relative(SRC_ROOT, targetAbs).split(/[\\/]/).join('/');
      const targetStripped = targetRel.endsWith('.ts') ? targetRel.slice(0, -'.ts'.length) : targetRel;
      if (targetDomain !== '_base' && !KOSONG_ALLOWED_VOCABULARY.has(targetStripped)) {
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

export function checkFile(absFile) {
  return checkSource(readFileSync(absFile, 'utf8'), absFile);
}

function walk(dir) {
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
