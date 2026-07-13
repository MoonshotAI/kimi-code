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
  // `_base/execEnv` (pure execution-env helpers such as
  // `probeHostEnvironmentFromNode`, `decodeTextWithErrors`,
  // `globPatternToRegex`, `BufferedReadable`) sits under `_base/*`, so the
  // `_base` L0 entry already covers it — no separate entry needed.
  // `errors` is a top-level facade (src/errors.ts) that aggregates every
  // domain's error codes; any domain may import it, so it sits at L0.
  ['errors', 0],
  // `llmProtocol` is v2's public wire-type namespace (`Message`,
  // `ContentPart`, `Tool`, `TokenUsage`, `FinishReason`, error classes,
  // etc.). It has no v2 dependencies of its own (it vendors the kosong wire
  // implementation directly within `llmProtocol`); every domain — including
  // `_base/utils/tokens` and `_base/errors/serialize` — may import wire types
  // through it, so it sits at L0.
  ['llmProtocol', 0],
  // L1 — abstraction bridges & low-level capabilities
  ['log', 1],
  ['sessionLog', 1],
  ['telemetry', 1],
  ['bootstrap', 1],
  // `environment` is the App-scope resolved startup snapshot: host facts, the
  // app path layout, and the env bag; low-level substrate that any domain may
  // read for paths/facts, so it sits in L1 beside `bootstrap` and the
  // `os/interface` host facts.
  ['environment', 1],
  // `event` is the App-scope pub/sub bus, a thin wrapper over the
  // `_base/event` `Emitter`. Foundational substrate that any domain may
  // publish/subscribe through, so it sits in L1 (not the edge boundary).
  ['event', 1],
  // `sessionContext` is the Session-scope seeded immutable facts value
  // (`sessionId`/`workspaceId`/`sessionDir`/`metaScope`/`cwd`); a pure seed
  // with no IO, so it sits in L1.
  ['sessionContext', 1],
  // `scopeContext` is the Agent-scope seeded immutable facts value
  // (`agentId` plus a persistence scope helper); a pure seed with no IO, so it
  // sits in L1 beside `sessionContext`.
  ['scopeContext', 1],
  // `git` is the App-scope `IGitService` that runs `git status` / `git diff`
  // against a local repo. Process spawning goes through `os/interface`
  // (`IHostProcessService`) and the lone path-existence probe through
  // `IHostFileSystem`; besides those host bridges it depends only on `_base`
  // and the `errors` facade, so it sits in L1 beside the other host bridges.
  ['git', 1],
  ['workspaceContext', 1],
  ['protocol', 1],
  ['hooks', 1],
  // `task` is the managed-concurrent-execution primitive (run + defer).
  // Depends only on `_base`; sits in L1 beside the other program-control
  // layer substrates.
  ['task', 1],
  // persistence/ and os/ — the two-level scopes. `interface` holds contracts
  // (same layer as the old domains they replace); `backends` holds
  // implementations that may depend on cross-domain services at various layers.
  // They are set high enough to absorb their highest real dependency.
  ['persistence/interface', 1],
  ['persistence/backends', 4],
  ['os/interface', 1],
  ['os/backends', 6],
  // L2 — data & cross-cutting capabilities
  ['records', 2],
  ['wireRecord', 2],
  // `wire` is the scope-agnostic Model/Op/Signal state-machine layer: it
  // consumes `persistence/interface` (L1) and is consumed by the scope tiers,
  // so it sits in L2 beside the other data/cross-cutting layers.
  ['wire', 2],
  ['blob', 2],
  ['file', 2],
  ['config', 2],
  ['workspaceLocalConfig', 2],
  ['sessionFs', 2],
  ['process', 2],
  ['workspaceRegistry', 2],
  ['hostFolderBrowser', 2],
  ['auth', 2],
  ['provider', 2],
  ['platform', 2],
  ['model', 2],
  ['sessionIndex', 2],
  ['sessionStore', 2],
  // L3 — registries & capabilities
  ['tool', 3],
  ['skill', 3],
  ['skillCatalog', 3],
  ['sessionSkillCatalog', 3],
  ['permissionGate', 3],
  ['flag', 3],
  ['toolExecutor', 3],
  ['toolResultTruncation', 3],
  ['toolRegistry', 3],
  ['userTool', 3],
  ['permissionMode', 3],
  ['permissionPolicy', 3],
  ['permissionRules', 3],
  ['plugin', 3],
  ['multiServer', 3],
  ['record', 3],
  ['modelCatalog', 3],
  ['agentProfileCatalog', 3],
  // L4 — agent behaviour
  ['activity', 4],
  ['context', 4],
  ['message', 4],
  ['injection', 4],
  ['compaction', 4],
  ['plan', 4],
  ['goal', 4],
  ['swarm', 4],
  ['usage', 4],
  ['runtime', 4],
  ['toolDedupe', 4],
  ['toolSelect', 4],
  ['contextMemory', 4],
  ['contextInjector', 4],
  ['agentPlugin', 4],
  ['systemReminder', 4],
  ['contextProjector', 4],
  ['contextSize', 4],
  ['fullCompaction', 4],
  ['loop', 4],
  ['stepRetry', 4],
  ['media', 4],
  // `edit` spans two scopes: the App-scope `IFileEditService` capability (pure
  // TextModel / EditService + os-backed read/write over the L1 hostFs bridge)
  // and the Agent-scope `EditTool` adapter (depends on the L3 tool contract /
  // registry and the L1 host bridges). The Agent adapter's L3 dependencies pin
  // the domain to L4 beside the other agent-behaviour tools.
  ['edit', 4],
  ['llmRequester', 4],
  ['faultInjection', 4],
  ['profile', 4],
  ['prompt', 4],
  // `shellCommand` orchestrates user `!` commands through `toolRegistry` (L3),
  // `contextMemory` / `prompt` (L4) and `eventBus` (L1); its highest dependency is L4.
  ['shellCommand', 4],
  ['replayBuilder', 4],
  ['todo', 4],
  ['web', 4],
  // L5 — agent task management
  ['agentTask', 5],
  ['mcp', 5],
  ['cron', 5],
  // `btw` forks a single side-question sub-agent via `agentLifecycle`,
  // parallel to how the `Agent` tool spawns child agents. Agent-scope, L5.
  ['btw', 5],
  // L6 — coordination
  ['agentLifecycle', 6],
  ['sessionLifecycle', 6],
  ['externalHooks', 6],
  ['externalHooksRunner', 6],
  ['sessionExport', 6],
  ['interaction', 6],
  ['sessionMetadata', 6],
  ['sessionActivity', 6],
  ['session', 6],
  ['terminal', 6],
  // `workspaceCommand` orchestrates session-level workspace mutations
  // (`addAdditionalDir`): it reaches through `agentLifecycle` (L6) to the
  // `main` agent's `contextMemory` (L4) to mirror the action's stdout, and
  // delegates project-local config persistence to `workspaceLocalConfig` (L2).
  // Its highest real dependency is `agentLifecycle`, so it sits in L6 beside
  // the other coordination domains.
  ['workspaceCommand', 6],
  // `sessionInit` runs the `/init` command: it reaches through `agentLifecycle`
  // (L6) to spawn the `coder` sub-agent and to the `main` agent's `profile`
  // (L4) / `systemReminder` (L4) / `wireRecord` (L4), and reloads `AGENTS.md`
  // through `profile` (L4). Its highest real dependency is `agentLifecycle`,
  // so it sits in L6 beside `workspaceCommand`.
  ['sessionInit', 6],
  // L7 — boundary
  ['approval', 7],
  ['question', 7],
  ['questionTools', 7],
  ['gateway', 7],
  ['rpc', 7],
  
  ['sessionLegacy', 7],
  ['authLegacy', 7],
  ['messageLegacy', 7],
]);

const V1_PACKAGE = '@moonshot-ai/agent-core';

/**
 * Scope directories introduced by the `src/{scope}/{domain}` layout. A path's
 * first segment is a scope tier, not a domain; the domain is the next segment.
 */
const SCOPE_DIRS = new Set(['app', 'session', 'agent', 'persistence', 'os']);

/**
 * Two-level scope directories: `persistence` and `os` use `{scope}/{tier}`
 * (e.g. `persistence/interface`, `os/backends`) as the domain key.
 */
const TWO_LEVEL_SCOPES = new Set(['persistence', 'os']);

/**
 * Resolve a `src/`-relative path to its domain, skipping the scope tier when
 * present. Returns `undefined` for top-level root files (e.g. the package
 * barrel `index.ts`, or the `errors`/`hooks` facades), which are exempt.
 * @param {string} rel
 */
function domainFromRel(rel, { exemptRootFile }) {
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
  // Top-level `src/*.ts` facades are not domains — exempt from layering.
  if (exemptRootFile && segments.length < 2) return undefined;
  return segments[0];
}

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
 *  - `bootstrap>skillCatalog` : composition root wires the skill catalog
 *                              Store to its filesystem backend (same role as
 *                              the storage backend bindings).
 *
 *  - `permissionGate>approval`  : permissionGate(Agent) requests approval(Session broker).
 *  - `userTool>interaction`     : userTool(Agent) requests host-side execution
 *                                 through the Session interaction broker.
 *  - `permissionPolicy>plan`     : plan-mode approval policies need the current
 *                                 Agent plan state to approve/deny tool use.
 *  - `permissionPolicy>swarm`    : swarm-mode approval policy needs the current
 *                                 Agent swarm state to approve AgentSwarm.
 *  - `skill>loop`           : skill activate starts a turn through the loop (same Agent scope intent).
 *  - `swarm>agentLifecycle`: swarm spawns/manages sub-agents.
 *  - `cron>agentLifecycle` : cron coordinator steers the main agent.
 *  - `cron>sessionContext`: cron scheduler reads session identity for store filtering.
 *  - `todo>agentLifecycle` : todo binds its tool/reminder into agents and its
 *                            resume resumer into the main agent via lifecycle handle.
 *
 * Post-rebase-v2 restructuring introduced cross-domain type sharing between
 * L3 (registries/capabilities) and L4 (agent behaviour). The tool contract
 * (`ExecutableTool` / `ToolExecution` / results) and the tool-execution hook
 * contexts (`ToolExecutionHookContext` / `ToolBeforeExecuteContext` / …) now
 * live in `tool` (L3); the only remaining L3→L4 import is a `loop` error /
 * event helper used by `toolExecutor` — surfaced for review rather than a
 * layering violation to fix here.
 */
const ALLOWED_EXCEPTIONS = new Set([
  'bootstrap>skillCatalog',
  // bootstrap is the composition root — it wires backends by design.
  'bootstrap>persistence/backends',
  // `auth` (KimiOAuth, L2) owns the OAuth-backed `WebSearch` tool and registers
  // it through the tool contribution API, so it reaches up to the L3 tool
  // contract and registry. Surfaced for review: the tool needs an authenticated
  // backend, which is why it lives beside the OAuth toolkit rather than in the
  // auth-independent `web` domain.
  'auth>tool',
  'auth>toolRegistry',
  'permissionGate>approval',
  'userTool>interaction',
  'permissionPolicy>plan',
  'permissionPolicy>swarm',
  'skill>loop',
  'swarm>agentLifecycle',
  'cron>agentLifecycle',
  'cron>sessionContext',
  'todo>agentLifecycle',
  'wireRecord>hooks',
  // L3/L4 type-sharing: tool contract + execution hook contexts now live in
  // `tool`; the remaining upward import is a `loop` error/event helper.
  'contextMemory>agentTask',
  'llmRequester>session',
  'loop>mcp',
  'permissionGate>externalHooks',
  'permissionMode>contextInjector',
  'permissionMode>replayBuilder',
  'permissionPolicy>externalHooks',
  'permissionPolicy>profile',
  'permissionRules>replayBuilder',
  'record>replayBuilder',
  // `record` owns the replay read model, whose `message` records carry
  // `ContextMessage` (L4). `removeLastMessages` takes a set of them, so the
  // projection side references the context message type by structure only.
  'record>contextMemory',
  'plugin>externalHooks',
  'plugin>mcp',
  'profile>session',
  'replayBuilder>agentTask',
  'replayBuilder>rpc',
  'replayBuilder>sessionMetadata',
  'skill>contextMemory',
  'skill>prompt',
  'swarm>sessionMetadata',
  'btw>agentLifecycle',
  'toolExecutor>loop',
  'userTool>profile',
  'wireRecord>contextMemory',
  'wireRecord>loop',
  'wireRecord>tool',
  'hostFolderBrowser>os/backends',
  'filestore>persistence/backends',
  'process>os/backends',
  'terminal>os/backends',
  'sessionFs>os/backends',
  'blobStore>persistence/backends',
  // `sessionIndex` (L2) reads the `persistence_minidb_readmodel` experimental
  // flag (L3) to switch session listings between the legacy N+1 disk read and
  // the minidb-backed derived read model. A genuine, planned upward dependency
  // on a cross-cutting capability switch — surfaced here for review.
  'sessionIndex>flag',
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
  return domainFromRel(rel, { exemptRootFile: true });
}

/**
 * Determine the v2 domain for an *import target* absolute path. Unlike
 * {@link domainOf} (which is for source files and exempts top-level barrels),
 * a target may resolve straight to a domain directory — e.g. the bare domain
 * import `#/turn` resolves to `src/agent/turn`, whose domain is `turn`.
 * @param {string} targetAbs
 */
function targetDomainOf(targetAbs) {
  const rel = relative(SRC_ROOT, targetAbs);
  if (rel.startsWith('..') || rel === '') return undefined;
  return domainFromRel(rel, { exemptRootFile: false });
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
    const targetDomain = targetDomainOf(targetAbs);
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
