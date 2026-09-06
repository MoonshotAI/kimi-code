#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
const TEST_ROOT = join(PKG_ROOT, 'test');
const HUMAN_ROOT = join(SRC_ROOT, 'human');
const ADAPTER_ROOT = join(SRC_ROOT, 'llm-adapter');
const LOOP_MACHINE_ADAPTER_ROOT = join(SRC_ROOT, 'agent/loop/machine');

const V1_PACKAGE = '@moonshot-ai/agent-core';
const SELF_PACKAGE_PREFIX = '@moonshot-ai/agent-core-v2/';
const KOSONG_PATH_RE = /(?:^|\/)kosong(?:\/|$)/;

const HUMAN_VOCABULARY = new Set([
  'llm/message',
  'llm/usage',
  'llm/capability',
  'llm/thinking',
  'llm/finish-reason',
  'llm/response-format',
  'llm/media/upload',
  'llm/requester/requester',
  'llm-kimi/trait',
]);

const V2_ONLY_FIRST_SEGMENTS = new Set([
  'llm-adapter',
  'app',
  'workspace',
  'features',
  'state',
  'wire',
  'persistence',
  'os',
  'mcpCore',
  'errors',
  'debug',
  'program',
  'runtime',
  '_base',
]);

function isInside(root, absPath) {
  const rel = relative(root, absPath);
  return rel !== '' && !rel.startsWith('..');
}

function humanSubpathOf(specifier) {
  if (specifier.startsWith('#human/')) return specifier.slice('#human/'.length);
  if (specifier.startsWith(`${SELF_PACKAGE_PREFIX}human/`)) {
    return specifier.slice(`${SELF_PACKAGE_PREFIX}human/`.length);
  }
  return undefined;
}

function stripTs(path) {
  return path.endsWith('.ts') ? path.slice(0, -'.ts'.length) : path;
}

function resolveIntraV2(specifier, fromFile) {
  if (specifier.startsWith('#human/')) {
    return join(HUMAN_ROOT, specifier.slice('#human/'.length));
  }
  if (specifier.startsWith('#/')) {
    if (isInside(HUMAN_ROOT, fromFile)) {
      return join(HUMAN_ROOT, specifier.slice(2));
    }
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
  const inHuman = isInside(HUMAN_ROOT, absFile);
  const inAdapter = isInside(ADAPTER_ROOT, absFile) || isInside(LOOP_MACHINE_ADAPTER_ROOT, absFile);

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

    if (KOSONG_PATH_RE.test(specifier)) {
      violations.push({
        file: absFile,
        line,
        message: `the kosong kernel is deleted (${specifier}) — request/provider code lives in #human/llm, the v2 compatibility boundary is #/llm-adapter`,
      });
      continue;
    }

    if (!inSrc) continue;

    if (inHuman) {
      if (specifier.startsWith('#/')) {
        const first = specifier.slice(2).split('/')[0];
        if (first !== undefined && V2_ONLY_FIRST_SEGMENTS.has(first)) {
          violations.push({
            file: absFile,
            line,
            message: `human must not import outside its kernel ('${specifier}') — human is the pure LLM/agent kernel: it never imports llm-adapter or v2 domains`,
          });
          continue;
        }
      }
      const targetAbs = resolveIntraV2(specifier, absFile);
      if (targetAbs !== undefined && !isInside(HUMAN_ROOT, targetAbs)) {
        violations.push({
          file: absFile,
          line,
          message: `human must not import outside its kernel ('${specifier}') — human is the pure LLM/agent kernel: it never imports llm-adapter or v2 domains`,
        });
      }
      continue;
    }

    const humanSub = humanSubpathOf(specifier);
    if (humanSub !== undefined && !inAdapter && !HUMAN_VOCABULARY.has(stripTs(humanSub))) {
      violations.push({
        file: absFile,
        line,
        message: `only llm-adapter and agent/loop/machine may import the human implementation ('${specifier}') — v2 code outside those adapter layers is limited to the vocabulary modules (${[...HUMAN_VOCABULARY].join(', ')})`,
      });
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
