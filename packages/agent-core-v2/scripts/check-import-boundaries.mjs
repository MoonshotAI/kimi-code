#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
const TEST_ROOT = join(PKG_ROOT, 'test');
const HUMAN_ROOT = join(SRC_ROOT, 'human');
const ADAPTER_ROOT = join(SRC_ROOT, 'llm-adapter');
const LOOP_MACHINE_ADAPTER_ROOT = join(SRC_ROOT, 'agent/loop/machine');

const SELF_PACKAGE_PREFIX = '@moonshot-ai/agent-core-v2/';
const KOSONG_PATH_RE = /(?:^|\/)kosong(?:\/|$)/;
const TRAIT_FILE_RE = /\/trait\.ts$/;
const FORMAT_LOWER_FILE_RE = /\/bases\/[^/]+\/(?:format|lower)\.ts$/;
const FORMAT_LOWER_MODULE_RE = /\/bases\/[^/]+\/(?:format|lower)$/;
const TRAIT_MODULE_RE = /\/trait$/;
const BASES_DIR_RE = /\/llm\/requester\/bases(?:\/|$)/;
const BASES_INTERNAL_MODULE_RE =
  /\/llm\/requester\/bases\/[^/]+\/(?:format|lower|patterns|reasoning-key)$/;
const TEST_DIR_RE = /\/test(?:\/|$)/;

function traitBoundaryViolation(absFile, targetAbs, specifier) {
  const message = `format and trait never import each other ('${specifier}') — both sides speak only the neutral wire/chunk types in the protocol's contract.ts`;
  if (TRAIT_FILE_RE.test(absFile) && FORMAT_LOWER_MODULE_RE.test(targetAbs)) {
    return message;
  }
  if (FORMAT_LOWER_FILE_RE.test(absFile) && TRAIT_MODULE_RE.test(targetAbs)) {
    return message;
  }
  return undefined;
}

function basesInternalViolation(absFile, targetAbs, specifier) {
  if (!BASES_INTERNAL_MODULE_RE.test(targetAbs)) return undefined;
  if (TRAIT_FILE_RE.test(absFile) && FORMAT_LOWER_MODULE_RE.test(targetAbs)) return undefined;
  if (BASES_DIR_RE.test(absFile) || TEST_DIR_RE.test(absFile)) return undefined;
  return `protocol format modules are internal to the requester pipeline ('${specifier}') — only llm/requester/bases code and tests may import format/lower/patterns; everyone else speaks contract/trait/requester`;
}

const HUMAN_VOCABULARY = new Set([
  'llm/message',
  'llm/usage',
  'llm/capability',
  'llm/thinking',
  'llm/finish-reason',
  'llm/response-format',
  'llm/media/upload',
  'llm/media/image-formats',
  'llm/requester/requester',
  'llm/toolCallIdNormalizer',
  'llm-kimi/trait',
  'interaction/interaction',
  'interaction/machine',
  'interaction/facade',
  'utils/watch',
  'xstate2',
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

    if (KOSONG_PATH_RE.test(specifier)) {
      violations.push({
        file: absFile,
        line,
        message: `the kosong kernel is deleted (${specifier}) — request/provider code lives in #human/llm, the v2 compatibility boundary is #/llm-adapter`,
      });
      continue;
    }

    if (!inSrc) continue;

    const targetAbs = resolveIntraV2(specifier, absFile);
    if (targetAbs !== undefined) {
      const basesInternal = basesInternalViolation(absFile, stripTs(targetAbs), specifier);
      if (basesInternal !== undefined) {
        violations.push({ file: absFile, line, message: basesInternal });
      }
    }

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
      if (targetAbs !== undefined && !isInside(HUMAN_ROOT, targetAbs)) {
        violations.push({
          file: absFile,
          line,
          message: `human must not import outside its kernel ('${specifier}') — human is the pure LLM/agent kernel: it never imports llm-adapter or v2 domains`,
        });
      }
      if (targetAbs !== undefined) {
        const traitBoundary = traitBoundaryViolation(absFile, stripTs(targetAbs), specifier);
        if (traitBoundary !== undefined) {
          violations.push({ file: absFile, line, message: traitBoundary });
        }
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

const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  process.exit(main());
}
