#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');
export const SRC_ROOT = join(PKG_ROOT, 'src');
const TEST_ROOT = join(PKG_ROOT, 'test');
const HUMAN_ROOT = join(SRC_ROOT, 'human');
const ADAPTER_ROOT = join(SRC_ROOT, 'llm-adapter');
const LOOP_ADAPTER_ROOT = join(SRC_ROOT, 'agent/loop');
const SESSION_LIFECYCLE_ADAPTER_ROOT = join(SRC_ROOT, 'session/agentLifecycle');
const REMOTE_SERVER_ROOT = join(SRC_ROOT, 'remote/server');
const REMOTE_SERVER_ALLOWED_RE =
  /^#\/(?:(?:remote\/protocol|os\/interface|_base\/execEnv)(?:\/|$)|os\/backends\/node-local\/(?:hostFsService|hostProcessService)$)/;
const REMOTE_SERVER_MODULE_RE = /\/remote\/server(?:\/|$)/;
const REMOTE_ASKPASS_FILE = join(SRC_ROOT, 'remote/askpass.ts');
const OS_REMOTE_BACKEND_ROOT = join(SRC_ROOT, 'os/backends/remote');
const OS_REMOTE_BACKEND_ALLOWED_RE = /^#\/(?:remote\/protocol|os\/interface|_base)(?:\/|$)/;
const ENVIRONMENT_ROOT = join(SRC_ROOT, 'environment');
const REMOTE_ROOT = join(SRC_ROOT, 'remote');
const REMOTE_DECLARATION_ROOT = join(SRC_ROOT, 'remote/declaration');
const REMOTE_CLIENT_ROOT = join(SRC_ROOT, 'remote/client');

const SELF_PACKAGE_PREFIX = '@moonshot-ai/agent-core-v2/';
const KOSONG_PATH_RE = /(?:^|\/)kosong(?:\/|$)/;
const PIPELINE_DIR_RE = /\/llm\/builtin\/(?:protocol|provider)(?:\/|$)/;
const PIPELINE_INTERNAL_MODULE_RE =
  /\/llm\/builtin\/protocol\/[^/]+\/(?:format|lower|patterns|reasoning-key)$/;
const TEST_DIR_RE = /\/test(?:\/|$)/;

function pipelineInternalViolation(absFile, targetAbs, specifier) {
  if (!PIPELINE_INTERNAL_MODULE_RE.test(targetAbs)) return undefined;
  if (PIPELINE_DIR_RE.test(absFile) || TEST_DIR_RE.test(absFile)) return undefined;
  return `protocol format modules are internal to the requester pipeline ('${specifier}') — only llm/builtin protocol/provider code and tests may import format/lower/patterns; everyone else speaks contract/requester`;
}

function remoteServerViolation(absFile, specifier) {
  if (!isInside(REMOTE_SERVER_ROOT, absFile)) return undefined;
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return undefined;
  if (REMOTE_SERVER_ALLOWED_RE.test(specifier)) return undefined;
  return `the remote executor stays light: src/remote/server may import only node builtins, relative modules, #/remote/protocol, #/os/interface, #/_base/execEnv and the node-local hostFsService / hostProcessService implementations ('${specifier}')`;
}

function remoteAskpassViolation(absFile, specifier) {
  if (absFile !== REMOTE_ASKPASS_FILE || specifier.startsWith('node:')) return undefined;
  return `the SSH askpass helper stays light: src/remote/askpass.ts may import only node builtins ('${specifier}') — the CLI process entry loads it before any engine module`;
}

function osRemoteBackendViolation(absFile, specifier) {
  if (!isInside(OS_REMOTE_BACKEND_ROOT, absFile)) return undefined;
  if (specifier.startsWith('.') || specifier.startsWith('node:')) return undefined;
  if (OS_REMOTE_BACKEND_ALLOWED_RE.test(specifier)) return undefined;
  return `the remote os backend is a sibling of node-local: src/os/backends/remote may import only node builtins, relative modules, #/remote/protocol, #/os/interface and #/_base ('${specifier}') — the transport and environment wiring live in src/remote/client`;
}

function remoteServerConsumerViolation(absFile, specifier) {
  if (isInside(REMOTE_SERVER_ROOT, absFile) || TEST_DIR_RE.test(absFile)) {
    return undefined;
  }
  const targetAbs = resolveIntraV2(specifier, absFile);
  if (targetAbs === undefined || !REMOTE_SERVER_MODULE_RE.test(stripTs(targetAbs))) {
    return undefined;
  }
  return `engine code never imports the remote executor ('${specifier}') — only tests and the CLI exec-server entry may touch src/remote/server; engine code speaks the client side (#/remote)`;
}

function environmentLayerViolation(absFile, targetAbs, specifier) {
  if (isInside(ENVIRONMENT_ROOT, absFile) && isInside(REMOTE_ROOT, targetAbs)) {
    return `the environment layer never imports the remote stack ('${specifier}') — src/environment holds the target-neutral Environment contract and registry; ssh/docker/command declarations and launchers live under src/remote`;
  }
  if (
    isInside(REMOTE_DECLARATION_ROOT, absFile) &&
    (isInside(REMOTE_CLIENT_ROOT, targetAbs) || isInside(REMOTE_SERVER_ROOT, targetAbs))
  ) {
    return `remote environment declarations stay transport-free ('${specifier}') — the main entry loads src/remote/declaration, so it never imports the remote client or executor`;
  }
  return undefined;
}

const HUMAN_VOCABULARY = new Set([
  'agent/origin',
  'message',
  'llm/message',
  'llm-requester/errors',
  'llm-requester/usage',
  'llm-requester/capability',
  'llm-requester/thinking',
  'llm-requester/finish-reason',
  'llm-requester/response-format',
  'llm-requester/requester',
  'media/upload',
  'llm/protocol/kit/media',
  'llm/builtin/provider/kimi/protocol',
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
  'environment',
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
  const inAdapter =
    isInside(ADAPTER_ROOT, absFile) ||
    isInside(LOOP_ADAPTER_ROOT, absFile) ||
    isInside(SESSION_LIFECYCLE_ADAPTER_ROOT, absFile);

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

    const remoteServer = remoteServerViolation(absFile, specifier);
    if (remoteServer !== undefined) {
      violations.push({ file: absFile, line, message: remoteServer });
      continue;
    }
    const remoteAskpass = remoteAskpassViolation(absFile, specifier);
    if (remoteAskpass !== undefined) {
      violations.push({ file: absFile, line, message: remoteAskpass });
      continue;
    }
    const osRemoteBackend = osRemoteBackendViolation(absFile, specifier);
    if (osRemoteBackend !== undefined) {
      violations.push({ file: absFile, line, message: osRemoteBackend });
      continue;
    }
    const remoteServerConsumer = remoteServerConsumerViolation(absFile, specifier);
    if (remoteServerConsumer !== undefined) {
      violations.push({ file: absFile, line, message: remoteServerConsumer });
      continue;
    }

    const targetAbs = resolveIntraV2(specifier, absFile);
    if (targetAbs !== undefined) {
      const pipelineInternal = pipelineInternalViolation(absFile, stripTs(targetAbs), specifier);
      if (pipelineInternal !== undefined) {
        violations.push({ file: absFile, line, message: pipelineInternal });
      }
      const environmentLayer = environmentLayerViolation(absFile, targetAbs, specifier);
      if (environmentLayer !== undefined) {
        violations.push({ file: absFile, line, message: environmentLayer });
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
      continue;
    }

    const humanSub = humanSubpathOf(specifier);
    if (humanSub !== undefined && !inAdapter && !HUMAN_VOCABULARY.has(stripTs(humanSub))) {
      violations.push({
        file: absFile,
        line,
        message: `only llm-adapter, agent/loop and session/agentLifecycle may import the human implementation ('${specifier}') — v2 code outside those adapter layers is limited to the vocabulary modules (${[...HUMAN_VOCABULARY].join(', ')})`,
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
