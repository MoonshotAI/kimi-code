/**
 * Scenario: v1↔v2 parity gate — for every SDK method migrated to
 * agent-core-v2, the v1 harness (`createKimiHarness`) and the v2 harness
 * (`createKimiHarnessV2`) must return identical values on the same fixture
 * home. A method only counts as migrated while its comparison here passes;
 * temporary, understood gaps are pinned explicitly in `KNOWN_DIFFS` so the
 * list can only shrink deliberately, never grow silently.
 * Wiring: real v1 core and real v2 engine, both in-process on a temp
 * KIMI_CODE_HOME; no provider calls.
 * Run: pnpm exec vitest run test/v1-v2-parity.test.ts
 */
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ISessionApprovalService,
  ISessionQuestionService,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';

import { McpOAuthService } from '../../agent-core/src/mcp/oauth/service';

import { startMcpAuthStatusServer } from './mcp-auth-status-server';

import {
  createKimiHarness,
  createKimiHarnessV2,
  ErrorCodes,
  SDKRpcClient,
  SDKRpcClientV2,
  type ApprovalRequest,
  type ApprovalResponse,
  type BackgroundTaskInfo,
  type ConfigDiagnostics,
  type Event,
  type ExportSessionResult,
  type GoalSnapshot,
  type GoalToolResult,
  type JsonObject,
  type KimiConfig,
  type KimiHarness,
  type McpServerConfig,
  type McpStartupMetrics,
  type PluginCommandDef,
  type PluginInfo,
  type PluginSummary,
  type QuestionRequest,
  type QuestionResult,
  type ResumedAgentState,
  type ResumedSessionSummary,
  type SessionPlan,
  type SessionSummary,
  type SkillSummary,
  type SDKRpcClientBase,
} from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    // Retry like session-runtime-helpers.removeTempDir: an engine's async
    // wire flush can recreate a file while the tree is being removed
    // (ENOTEMPTY/EBUSY under load).
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Section values the v2 engine materializes in its effective view
 * (`config.getAll()`) even when the file never sets them, while v1's schema
 * leaves the same fields absent (only `providers` defaults, on both sides).
 * Two sources: registered `defaultValue`s (models/image/subagent/
 * defaultPlanMode/extraSkillDirs/mergeAllAvailableSkills — see the v2
 * `configSection.ts` registrations) and the env-binding pass, which
 * materializes `{}` for every section that declares env bindings
 * (thinking/services/loopControl/background/mcp) even with no env set.
 */
const V2_INJECTED_SECTION_DEFAULTS: Record<string, unknown> = {
  models: {},
  image: {},
  thinking: {},
  services: {},
  loopControl: {},
  background: {},
  mcp: {},
  defaultPlanMode: false,
  mergeAllAvailableSkills: true,
  extraSkillDirs: [],
  subagent: { timeoutMs: 7_200_000 },
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Projection for every method returning a `KimiConfig`: drop the fields whose
 * presence semantics genuinely differ between the engines (see KNOWN_DIFFS).
 */
function projectConfig(config: KimiConfig): unknown {
  const projected: Record<string, unknown> = { ...config };
  delete projected['raw'];
  for (const [field, defaultValue] of Object.entries(V2_INJECTED_SECTION_DEFAULTS)) {
    if (deepEqual(projected[field], defaultValue)) delete projected[field];
  }
  return projected;
}

/**
 * Both forms of a home dir: the path as handed to the harness and its
 * realpath. Installed plugins land in a realpath'd managed copy under
 * `<home>/plugins/managed/<id>`, and on macOS the temp dir itself is behind
 * a symlink, so scrubbing needs both spellings.
 */
interface HomePair {
  readonly raw: string;
  readonly real: string;
}

/**
 * Replace every occurrence of a home prefix with `<HOME>` so values holding
 * absolute paths into a per-engine home compare across the isolated homes.
 */
function scrubHomePrefixes(value: unknown, home: HomePair): unknown {
  let text = JSON.stringify(value);
  // Longest first, so the more specific spelling wins when they overlap.
  for (const prefix of [home.raw, home.real].toSorted((a, b) => b.length - a.length)) {
    text = text.replaceAll(prefix, '<HOME>');
  }
  return JSON.parse(text);
}

/**
 * Understood v1↔v2 return-value gaps, pinned per method with the reason.
 * Each entry is a projection applied to BOTH results before comparison, so
 * the comparison still covers everything not listed here. Keep empty unless a
 * gap is genuinely accepted; remove entries as gaps close.
 */
const KNOWN_DIFFS = {
  // v2's flag registry is per-domain and already carries flags v1 does not
  // have (minidb backend, subagent); v1-only flags would be the symmetric
  // case. Parity is enforced on the intersection of ids until the registries
  // are unified.
  getExperimentalFeatures: (
    features: readonly { id: string }[],
    other: readonly { id: string }[],
  ): readonly { id: string }[] => {
    const otherIds = new Set(other.map((feature) => feature.id));
    return features.filter((feature) => otherIds.has(feature.id));
  },
  // `raw`: the v1 write path carries a passthrough clone of the original
  // TOML document inside the returned config; the v2 engine keeps the same
  // document internally (rawSnake) but never exposes it through the config
  // service. v2-injected section defaults: see V2_INJECTED_SECTION_DEFAULTS.
  getConfig: (config: KimiConfig): unknown => projectConfig(config),
  setConfig: (config: KimiConfig): unknown => projectConfig(config),
  removeProvider: (config: KimiConfig): unknown => projectConfig(config),
  // Both engines report a dropped invalid section, but the warning wording
  // differs by design (v1: one salvage summary naming the dropped sections;
  // v2: one structured diagnostic per dropped domain). Parity is enforced on
  // the warning count; message text is compared only when both are empty.
  getConfigDiagnostics: (diagnostics: ConfigDiagnostics): unknown =>
    diagnostics.warnings.length,
  // `getPluginInfo` carries volatile install facts: `root` / `manifestPath`
  // point into the per-home managed copy and `installedAt` / `updatedAt` are
  // stamped at install time — per-home and per-run by construction, not a
  // semantic difference. Everything else (manifest echo, MCP server info,
  // counts, diagnostics) compares in full after the home-prefix scrub.
  getPluginInfo: (info: PluginInfo, home: HomePair): unknown => {
    const projected = scrubHomePrefixes(info, home) as Record<string, unknown>;
    delete projected['root'];
    delete projected['installedAt'];
    delete projected['updatedAt'];
    delete projected['manifestPath'];
    return projected;
  },
  // Command `path`s point into the per-home managed copy; after the scrub
  // the defs compare in full. Scope note: v1 answers from the session's
  // creation-time snapshot of enabled commands, v2 from the app-global live
  // view — parity holds here because the v1 session is created after the
  // install (see the SDKRpcClientV2.listPluginCommands comment).
  listPluginCommands: (defs: readonly PluginCommandDef[], home: HomePair): unknown =>
    scrubHomePrefixes(defs, home),
  // Sessions: `createdAt` / `updatedAt` are per-run wall clock on both
  // engines (v1 reads fs birth/mtime off the session directory, v2 reads the
  // metadata stamps) — deleted, not compared. v1's store materializes the
  // default title 'New Session' into state.json and reports it for
  // never-titled sessions where v2 leaves the title unset; only that
  // materialized default is projected away (explicit titles compare in
  // full). Per-home paths (sessionDir, agent homedirs) compare after the
  // home-prefix scrub — both engines lay sessions out as
  // `<home>/sessions/<workdir-key>/<id>` with the same key derivation.
  listSessions: (summaries: readonly SessionSummary[], home: HomePair): unknown =>
    summaries.map((summary) => projectSessionSummary(summary, home)),
  createSession: (summary: SessionSummary, home: HomePair): unknown =>
    projectSessionSummary(summary, home),
  // v1's fork returns the full resumed result (it resumes the fork); v2
  // mirrors that shape, so both project like a resume.
  forkSession: (resumed: ResumedSessionSummary, home: HomePair): unknown =>
    projectResumedSession(resumed, home),
  // Both engines resume the session and now return the per-agent snapshot;
  // `agents` compares field-by-field after the projections documented on
  // `projectResumedAgent` (bind-time config_updated replay records,
  // config.provider / systemPrompt rendering, the tokenCount
  // estimate-vs-measured divergence, per-run times and random ids, and the
  // engine-owned tool roster/description drift). `sessionMetadata` compares
  // on the overlapping document fields after the same timestamp/title
  // projection.
  resumeSession: (resumed: ResumedSessionSummary, home: HomePair): unknown =>
    projectResumedSession(resumed, home),
  reloadSession: (resumed: ResumedSessionSummary, home: HomePair): unknown =>
    projectResumedSession(resumed, home),
  // Agent context: v1 reports the running token ESTIMATE; v2 reports the
  // provider-MEASURED prefix. In-memory appends (e.g. importContext) count
  // identically on both engines via the shared `estimateTokensForMessages`,
  // but once the provider reports measured usage the counts diverge by
  // design. Histories compare in full; the count compares only in the
  // pre-LLM state where both sides still estimate.
  getContext: (context: { readonly history: readonly unknown[] }): unknown =>
    context.history.length === 0 ? context : { history: context.history },
  // Plan ids are random per engine (hero slugs) and the plan path embeds
  // both the per-home session dir and the id, so the comparison covers the
  // content and the path LAYOUT (id scrubbed); the id itself is asserted
  // non-empty at the call site.
  getPlan: (plan: SessionPlan, home: HomePair): unknown => {
    if (plan === null) return null;
    const projected = scrubHomePrefixes({ content: plan.content, path: plan.path }, home) as {
      content: string;
      path: string;
    };
    return { ...projected, path: projected.path.replaceAll(plan.id, '<PLAN_ID>') };
  },
  // Goal snapshots: `goalId` is a per-engine random uuid and `wallClockMs`
  // is per-run wall clock (it keeps accruing while the goal is active, so
  // even a same-moment read differs by execution time) — both deleted;
  // everything else (objective, status, counters, the full budget report,
  // terminalReason) compares in full. Id non-emptiness is asserted at the
  // call sites.
  createGoal: (snapshot: GoalSnapshot | null): unknown => projectGoalSnapshot(snapshot),
  getGoal: (result: GoalToolResult): unknown => projectGoalSnapshot(result.goal),
  pauseGoal: (snapshot: GoalSnapshot | null): unknown => projectGoalSnapshot(snapshot),
  resumeGoal: (snapshot: GoalSnapshot | null): unknown => projectGoalSnapshot(snapshot),
  cancelGoal: (snapshot: GoalSnapshot | null): unknown => projectGoalSnapshot(snapshot),
  // Background task infos: `taskId` embeds a per-engine random suffix and
  // `pid` / `startedAt` / `endedAt` are per-run facts — deleted. `timeoutMs`
  // diverges after a detach by design (v1 keeps the foreground deadline in
  // the reported info; v2 rewrites it to the detach deadline — pinned in the
  // migration tracker), so it is deleted too; the pre-detach equality is
  // asserted explicitly at the call site. Everything else (kind, command,
  // description, status, detached, exitCode, stopReason, flags) compares in
  // full.
  listBackgroundTasks: (tasks: readonly BackgroundTaskInfo[]): unknown =>
    tasks.map((task) => projectBackgroundTask(task)),
  detachBackgroundTask: (info: BackgroundTaskInfo | undefined): unknown =>
    info === undefined ? undefined : projectBackgroundTask(info),
  // MCP startup metrics: `durationMs` is per-run wall clock on both engines
  // (connect settle time) — projected away and asserted numeric at the call
  // site. The empty-config session reports exactly 0 on both (no connectAll
  // ever runs) and compares in full there.
  getMcpStartupMetrics: (metrics: McpStartupMetrics): unknown =>
    Object.keys(metrics).length === 1 ? {} : metrics,
  // Session export: `zipPath` is the caller-chosen output (different per
  // engine by construction) — deleted. `sessionDir` compares after the
  // home-prefix scrub (same `<home>/sessions/<workdir-key>/<id>` layout on
  // both). In the manifest: `exportedAt` is per-run wall clock;
  // `wireProtocolVersion` is each engine's own wire version (v1 '1.4' vs v2
  // '1.5' — genuinely different formats); the activity timestamps only exist
  // on v2 because v1's scanner reads a stale root `wire.jsonl` path (v1
  // keeps its wire under `agents/main/`, so v1 never reports them — a v1-side
  // defect, not a v2 divergence); and v1's store materializes the default
  // title 'New Session' where v2 leaves it unset (same rule as listSessions).
  exportSession: (result: ExportSessionResult, home: HomePair): unknown => {
    const projected = scrubHomePrefixes(result, home) as Record<string, unknown>;
    delete projected['zipPath'];
    const manifest = projected['manifest'] as Record<string, unknown>;
    delete manifest['exportedAt'];
    delete manifest['wireProtocolVersion'];
    delete manifest['sessionFirstActivity'];
    delete manifest['sessionLastActivity'];
    if (manifest['title'] === 'New Session') delete manifest['title'];
    return projected;
  },
  // Session skills: `path`s point into each engine's own home (user skills)
  // or the shared packages (builtins) — after the home-prefix scrub the
  // summaries compare in full.
  listSkills: (skills: readonly SkillSummary[], home: HomePair): unknown =>
    scrubHomePrefixes(skills, home),
} satisfies Record<string, (value: never, other: never) => unknown>;

/** See the KNOWN_DIFFS goal note above for what this projects and why. */
function projectGoalSnapshot(snapshot: GoalSnapshot | null): unknown {
  if (snapshot === null) return null;
  const projected: Record<string, unknown> = { ...snapshot };
  delete projected['goalId'];
  delete projected['wallClockMs'];
  return projected;
}

/** See the KNOWN_DIFFS background-task note above for what this projects and why. */
function projectBackgroundTask(info: BackgroundTaskInfo): unknown {
  const projected: Record<string, unknown> = { ...info };
  delete projected['taskId'];
  delete projected['pid'];
  delete projected['startedAt'];
  delete projected['endedAt'];
  delete projected['timeoutMs'];
  return projected;
}

/** See the KNOWN_DIFFS sessions note above for what this projects and why. */
function projectSessionSummary(summary: SessionSummary, home: HomePair): unknown {
  const projected = scrubHomePrefixes(summary, home) as Record<string, unknown>;
  delete projected['createdAt'];
  delete projected['updatedAt'];
  // `lastTurnReason` is v2-only: the v1 engine never records a turn outcome,
  // so the field cannot compare across engines.
  delete projected['lastTurnReason'];
  if (projected['title'] === 'New Session') delete projected['title'];
  return projected;
}

/** See the KNOWN_DIFFS resume/reload note above for what this projects and why. */
function projectResumedSession(resumed: ResumedSessionSummary, home: HomePair): unknown {
  const projected = projectSessionSummary(resumed, home) as Record<string, unknown>;
  projected['agents'] = projectResumedAgents(resumed.agents, home);
  const metadata = projected['sessionMetadata'] as Record<string, unknown>;
  delete metadata['createdAt'];
  delete metadata['updatedAt'];
  // v1 defaults an untitled metadata document to 'New Session'; the v2
  // mapping reports the same unset title as ''.
  if (metadata['title'] === 'New Session' || metadata['title'] === '') {
    delete metadata['title'];
  }
  return projected;
}

function projectResumedAgents(
  agents: ResumedSessionSummary['agents'],
  home: HomePair,
): unknown {
  const projected: Record<string, unknown> = {};
  for (const [agentId, agent] of Object.entries(agents)) {
    projected[agentId] = projectResumedAgent(agent, home);
  }
  return projected;
}

/**
 * The per-agent projections of the resume comparison, each a genuinely
 * accepted engine gap rather than resume data:
 * - `config.provider`: v1 resolves the full runtime ProviderConfig into the
 *   snapshot; agent-core-v2 has no equivalent read and the v2 client always
 *   reports undefined (the TUI only falls back to `provider?.model` when
 *   `modelAlias` is unset).
 * - `config.systemPrompt`: bootstrap-rendered profile content (engine-owned),
 *   not resume data — it embeds the host's skill listing, whose truncation
 *   the two engines render differently (`…` vs `...`).
 * - `config.profileName` on a MODEL-LESS home: v1
 *   still binds the default profile (and renders its prompt) without a
 *   model, where v2's bind requires a model and deliberately leaves the
 *   agent unbound (the same model-less gap the getStatus parity pins). With
 *   a configured model both bind the same profile and compare in full.
 * - `config.subagentNames`: v1's config snapshot carries the bound profile's
 *   delegatable subagent roster (custom agent files are a v1-engine feature);
 *   v2's resumed agent state has no equivalent field. Engine-owned profile
 *   data, not resume data.
 * - `context.tokenCount`: the KNOWN_DIFFS.getContext divergence (v1's running
 *   estimate vs v2's provider-measured prefix once the provider reports
 *   usage) — the history compares in full, the count only where both sides
 *   still estimate.
 * - replay `config_updated` records: v1 persists the profile BIND as
 *   `config.update` records (which restore maps to config_updated entries);
 *   v2 persists it as a `profile.bind` op the replay fold deliberately does
 *   not translate. Runtime config changes (`config.update`) still fold and
 *   compare — only the bind-time entries exist in these fixtures, so the
 *   type is dropped from both sides.
 * - replay `time`: per-run wall clock. A goal snapshot's `goalId` /
 *   `wallClockMs`: the KNOWN_DIFFS goal rule (per-engine random uuid /
 *   accruing clock).
 * - `plan`: the KNOWN_DIFFS.getPlan rule (random hero-slug id, scrubbed out
 *   of the path after the home scrub).
 * - `tools`: compared as sorted {name, active, source} triples. Tool
 *   DESCRIPTIONS are engine-owned constants that legitimately drift between
 *   the engines (the subagent/cron docs embed engine-specific facts), and
 *   v1 additionally registers the `select_tools` meta tool v2 has no
 *   counterpart for — both are engine design, not resume data. A model-less
 *   agent's roster is not compared at all (v1 initializes builtin tools
 *   only on a profiled agent; v2 exposes them unbound).
 */
function projectResumedAgent(agent: ResumedAgentState, home: HomePair): unknown {
  const projected = scrubHomePrefixes(agent, home) as Record<string, unknown>;
  const config = projected['config'] as Record<string, unknown>;
  delete config['provider'];
  delete config['systemPrompt'];
  delete config['subagentNames'];
  const modelLess = config['modelAlias'] === undefined;
  if (modelLess) {
    delete config['profileName'];
    projected['tools'] = [];
  } else {
    const tools = projected['tools'] as readonly Record<string, unknown>[];
    projected['tools'] = tools
      .filter((tool) => tool['name'] !== 'select_tools')
      .map((tool) => ({ name: tool['name'], active: tool['active'], source: tool['source'] }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  const context = projected['context'] as { readonly history: readonly unknown[] };
  projected['context'] =
    context.history.length === 0 ? context : { history: context.history };
  const replay = (projected['replay'] as readonly Record<string, unknown>[])
    .filter((record) => record['type'] !== 'config_updated')
    .map((record) => {
      const { time: _time, ...rest } = record;
      if (rest['type'] === 'goal_updated') {
        rest['snapshot'] = projectGoalSnapshot(rest['snapshot'] as GoalSnapshot);
      }
      return rest;
    });
  projected['replay'] = replay;
  const plan = projected['plan'] as { id: string; content: string; path: string } | null;
  if (plan !== null) {
    projected['plan'] = {
      content: plan.content,
      path: plan.path.replaceAll(plan.id, '<PLAN_ID>'),
    };
  }
  return projected;
}

/** Cross the same JSON boundary both engines' values already crossed, then
 *  sort object arrays by `key` so ordering differences don't count. */
function normalize(value: unknown, key: string): unknown {
  const roundTripped: unknown = JSON.parse(JSON.stringify(value));
  if (Array.isArray(roundTripped)) {
    return roundTripped.toSorted((a, b) =>
      JSON.stringify(a[key] ?? a).localeCompare(JSON.stringify(b[key] ?? b)),
    );
  }
  return roundTripped;
}

interface ParityFixture {
  readonly v1: KimiHarness;
  readonly v2: KimiHarness;
  readonly homeDir: string;
}

async function makeParityPair(): Promise<ParityFixture> {
  const homeDir = await makeTempDir('kimi-sdk-parity-home-');
  const v1 = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
  const v2 = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
  return { v1, v2, homeDir };
}

async function closeAll(...harnesses: readonly KimiHarness[]): Promise<void> {
  for (const harness of harnesses) {
    await harness.close();
  }
}

/**
 * Config-reading env vars both engines honor (`KIMI_MODEL_*`, the per-section
 * bindings, ...). Config parity cases scrub them so a developer machine's own
 * environment cannot inject extra providers/models/overrides into one engine
 * and skew the comparison; the original values are restored on cleanup.
 */
const CONFIG_ENV_PATTERN =
  /^(KIMI_MODEL_|KIMI_LOOP_|KIMI_MCP_|KIMI_WEB_|KIMI_SECONDARY_|KIMI_IMAGE_|KIMI_CODE_BACKGROUND_|KIMI_CODE_MODEL_CATALOG_)/;

function scrubConfigEnv(): () => void {
  const saved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && CONFIG_ENV_PATTERN.test(key)) {
      saved[key] = value;
      delete process.env[key];
    }
  }
  return () => {
    Object.assign(process.env, saved);
  };
}

/**
 * Config parity uses SEPARATE homes (the batch rule: a write through one
 * engine must not be observed by the other mid-test) with the same fixture
 * config.toml written into each before the harnesses are constructed.
 */
async function makeIsolatedParityPair(
  configToml?: string,
): Promise<{ v1: KimiHarness; v2: KimiHarness }> {
  const v1Home = await makeTempDir('kimi-sdk-parity-v1-home-');
  const v2Home = await makeTempDir('kimi-sdk-parity-v2-home-');
  if (configToml !== undefined) {
    await writeFile(join(v1Home, 'config.toml'), configToml, 'utf-8');
    await writeFile(join(v2Home, 'config.toml'), configToml, 'utf-8');
  }
  return {
    v1: createKimiHarness({ homeDir: v1Home, identity: TEST_IDENTITY }),
    v2: createKimiHarnessV2({ homeDir: v2Home, identity: TEST_IDENTITY }),
  };
}

/**
 * Representative config.toml covering every section the v1↔v2 field mapping
 * shares: providers/models with default pointers, thinking, loop_control,
 * background, subagent, mcp, image, experimental, permission rules, hooks,
 * services, and the pass-through scalars. `[model_catalog]` is deliberately
 * absent: v1's TOML transform drops that section (plain-object key without a
 * transform branch), so v1 never returns it while v2 does — pinned in the
 * migration tracker, not exercised here.
 */
const FIXTURE_CONFIG_TOML = `
default_provider = "fixture-provider"
default_model = "fixture-model"
default_permission_mode = "auto"
plan_mode = false
yolo = false
telemetry = false
merge_all_available_skills = false
extra_skill_dirs = ["/tmp/parity-extra-skills"]

[providers.fixture-provider]
type = "kimi"
api_key = "fixture-api-key"
base_url = "https://example.com/v1"

[providers.second-provider]
type = "openai"
api_key = "second-api-key"

[models.fixture-model]
provider = "fixture-provider"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["thinking"]

[models.second-model]
provider = "second-provider"
model = "second-brain"
max_context_size = 128000

[thinking]
enabled = true
effort = "high"

[loop_control]
max_steps_per_turn = 50

[background]
max_running_tasks = 4

[subagent]
timeout_ms = 60000

[mcp]
startup_timeout_ms = 45000

[image]
max_edge_px = 1024

[experimental]
parity-flag = true

[permission]
deny = [{ tool = "Bash" }]

[[hooks]]
event = "SessionStart"
command = "echo parity"

[services.moonshot_search]
base_url = "https://example.com/search"
api_key = "search-api-key"
`;

/** One schema-invalid section (thinking.enabled must be a boolean). */
const BROKEN_CONFIG_TOML = `
[providers.fixture-provider]
type = "kimi"
api_key = "fixture-api-key"

[thinking]
enabled = "not-a-boolean"
`;

/**
 * Secondary-model parity fixture: one resolvable model and the experiment
 * enabled, no `[secondary_model]` recipe — the apply cases persist the recipe
 * through `setConfig` mid-test.
 */
const SECONDARY_MODEL_CONFIG_TOML = `
default_provider = "fixture-provider"
default_model = "fixture-model"

[providers.fixture-provider]
type = "kimi"
api_key = "fixture-api-key"
base_url = "https://example.com/v1"

[models.fixture-model]
provider = "fixture-provider"
model = "kimi-for-coding"
max_context_size = 262144

[experimental]
secondary-model = true
`;

/** Same fixture with a dangling `[secondary_model]` pointer baked in. */
const SECONDARY_MODEL_BROKEN_CONFIG_TOML = `${SECONDARY_MODEL_CONFIG_TOML}
[secondary_model]
model = "missing-model"
`;

function expectConfigParity(v1Config: KimiConfig, v2Config: KimiConfig): void {
  const project = KNOWN_DIFFS.getConfig;
  expect(normalize(project(v2Config), '')).toEqual(normalize(project(v1Config), ''));
}

describe('v1↔v2 return-value parity', () => {
  it('getExperimentalFeatures matches on the shared flag ids', async () => {
    const { v1, v2 } = await makeParityPair();
    try {
      const [v1Features, v2Features] = await Promise.all([
        v1.getExperimentalFeatures(),
        v2.getExperimentalFeatures(),
      ]);
      const project = KNOWN_DIFFS.getExperimentalFeatures;
      expect(normalize(project(v2Features, v1Features), 'id')).toEqual(
        normalize(project(v1Features, v2Features), 'id'),
      );
    } finally {
      await closeAll(v1, v2);
    }
  });

  it('listWorkspaceSkills returns the same skills on the same fixture', async () => {
    const { v1, v2, homeDir } = await makeParityPair();
    const workDir = await makeTempDir('kimi-sdk-parity-work-');
    await writeSkill(join(homeDir, 'skills', 'parity-user-skill'), 'parity-user-skill');
    await writeSkill(
      join(workDir, '.kimi-code', 'skills', 'parity-project-skill'),
      'parity-project-skill',
    );
    try {
      const [v1Skills, v2Skills] = await Promise.all([
        v1.listWorkspaceSkills(workDir),
        v2.listWorkspaceSkills(workDir),
      ]);
      expect(normalize(v2Skills, 'name')).toEqual(normalize(v1Skills, 'name'));
    } finally {
      await closeAll(v1, v2);
    }
  });

  it('getConfig matches on an empty home (no config.toml)', async () => {
    const restoreEnv = scrubConfigEnv();
    const { v1, v2 } = await makeIsolatedParityPair();
    try {
      const [v1Config, v2Config] = await Promise.all([v1.getConfig(), v2.getConfig()]);
      expectConfigParity(v1Config, v2Config);
    } finally {
      await closeAll(v1, v2);
      restoreEnv();
    }
  });

  it('getConfig matches on a representative config.toml, with and without reload', async () => {
    const restoreEnv = scrubConfigEnv();
    const { v1, v2 } = await makeIsolatedParityPair(FIXTURE_CONFIG_TOML);
    try {
      const [v1Config, v2Config] = await Promise.all([v1.getConfig(), v2.getConfig()]);
      expectConfigParity(v1Config, v2Config);
      const [v1Reloaded, v2Reloaded] = await Promise.all([
        v1.getConfig({ reload: true }),
        v2.getConfig({ reload: true }),
      ]);
      expectConfigParity(v1Reloaded, v2Reloaded);
    } finally {
      await closeAll(v1, v2);
      restoreEnv();
    }
  });

  it('setConfig returns the same merged config and reads back identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const { v1, v2 } = await makeIsolatedParityPair(FIXTURE_CONFIG_TOML);
    try {
      const patch = {
        defaultModel: 'second-model',
        thinking: { effort: 'low' },
        experimental: { 'new-flag': false },
        yolo: true,
      };
      const [v1Config, v2Config] = await Promise.all([
        v1.setConfig(patch),
        v2.setConfig(patch),
      ]);
      const project = KNOWN_DIFFS.setConfig;
      expect(normalize(project(v2Config), '')).toEqual(normalize(project(v1Config), ''));
      // The write also persisted: a fresh read through each engine agrees.
      const [v1ReadBack, v2ReadBack] = await Promise.all([v1.getConfig(), v2.getConfig()]);
      expectConfigParity(v1ReadBack, v2ReadBack);
    } finally {
      await closeAll(v1, v2);
      restoreEnv();
    }
  });

  it('removeProvider cascades to models and default pointers identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const { v1, v2 } = await makeIsolatedParityPair(FIXTURE_CONFIG_TOML);
    try {
      const [v1Config, v2Config] = await Promise.all([
        v1.removeProvider('fixture-provider'),
        v2.removeProvider('fixture-provider'),
      ]);
      const project = KNOWN_DIFFS.removeProvider;
      expect(normalize(project(v2Config), '')).toEqual(normalize(project(v1Config), ''));
      // v1 semantics: the provider entry, every model whose `provider` points
      // at it, and both default pointers (the default model was one of the
      // removed models) are gone.
      for (const config of [v1Config, v2Config]) {
        expect(Object.keys(config.providers)).toEqual(['second-provider']);
        expect(config.models !== undefined && 'fixture-model' in config.models).toBe(false);
        expect(config.defaultModel).toBeUndefined();
        expect(config.defaultProvider).toBeUndefined();
      }
      const [v1ReadBack, v2ReadBack] = await Promise.all([v1.getConfig(), v2.getConfig()]);
      expectConfigParity(v1ReadBack, v2ReadBack);
    } finally {
      await closeAll(v1, v2);
      restoreEnv();
    }
  });

  it('getConfigDiagnostics is empty on a valid config', async () => {
    const restoreEnv = scrubConfigEnv();
    const { v1, v2 } = await makeIsolatedParityPair(FIXTURE_CONFIG_TOML);
    try {
      const [v1Diagnostics, v2Diagnostics] = await Promise.all([
        v1.getConfigDiagnostics(),
        v2.getConfigDiagnostics(),
      ]);
      expect(normalize(v2Diagnostics, '')).toEqual(normalize(v1Diagnostics, ''));
      expect(v1Diagnostics.warnings).toEqual([]);
    } finally {
      await closeAll(v1, v2);
      restoreEnv();
    }
  });

  it('getConfigDiagnostics reports a dropped invalid section on both engines', async () => {
    const restoreEnv = scrubConfigEnv();
    const { v1, v2 } = await makeIsolatedParityPair(BROKEN_CONFIG_TOML);
    try {
      const [v1Diagnostics, v2Diagnostics] = await Promise.all([
        v1.getConfigDiagnostics(),
        v2.getConfigDiagnostics(),
      ]);
      const project = KNOWN_DIFFS.getConfigDiagnostics;
      expect(project(v2Diagnostics)).toEqual(project(v1Diagnostics));
      expect(v1Diagnostics.warnings.length).toBeGreaterThan(0);
      // The valid sections survive the drop on both engines.
      const [v1Config, v2Config] = await Promise.all([v1.getConfig(), v2.getConfig()]);
      expectConfigParity(v1Config, v2Config);
    } finally {
      await closeAll(v1, v2);
      restoreEnv();
    }
  });
});

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Skill ${name} for the parity test\n---\n\nBody of ${name}.\n`,
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Plugin parity
//
// The plugin methods live on the rpc client itself (KimiHarness has no
// plugin surface), so plugin parity drives `SDKRpcClient` / `SDKRpcClientV2`
// directly. Homes stay isolated (same rule as config parity), and both
// engines install from ONE shared local source directory — zip-url / github
// install forms need the network and are deliberately out of scope (pinned
// in the migration tracker).
// ---------------------------------------------------------------------------

interface PluginParityPair {
  readonly v1: SDKRpcClient;
  readonly v2: SDKRpcClientV2;
  readonly v1Home: HomePair;
  readonly v2Home: HomePair;
  readonly sourceDir: string;
}

const FIXTURE_PLUGIN_ID = 'parity-plugin';

/**
 * One fixture plugin exercising every shared PluginSummary/PluginInfo field:
 * one discoverable skill, two MCP servers (stdio + http), a hook, a command
 * file, a session-start entry, and the interface block.
 */
async function writeFixturePlugin(dir: string): Promise<void> {
  await mkdir(join(dir, 'skills', 'parity-skill'), { recursive: true });
  await mkdir(join(dir, 'commands'), { recursive: true });
  await writeFile(
    join(dir, 'kimi.plugin.json'),
    JSON.stringify(
      {
        name: FIXTURE_PLUGIN_ID,
        version: '1.2.3',
        description: 'Plugin for the v1↔v2 parity test',
        keywords: ['parity', 'test'],
        author: { name: 'Parity Author', email: 'parity@example.com' },
        homepage: 'https://example.com/parity-plugin',
        license: 'MIT',
        skills: ['./skills'],
        sessionStart: { skill: 'parity-skill' },
        mcpServers: {
          'parity-stdio': {
            transport: 'stdio',
            command: 'parity-server',
            args: ['--serve', '--verbose'],
            env: { PARITY_TOKEN: 'fixture', PARITY_MODE: 'test' },
          },
          'parity-http': {
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { 'X-Parity': '1' },
          },
        },
        hooks: [{ event: 'SessionStart', command: 'echo parity' }],
        commands: './commands',
        interface: {
          displayName: 'Parity Plugin',
          shortDescription: 'Parity fixture',
          developerName: 'Parity Author',
          websiteURL: 'https://example.com/parity-plugin',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(
    join(dir, 'skills', 'parity-skill', 'SKILL.md'),
    '---\nname: parity-skill\ndescription: Skill from the parity fixture plugin\n---\n\nParity skill body.\n',
    'utf-8',
  );
  await writeFile(
    join(dir, 'commands', 'parity-command.md'),
    '---\nname: parity-command\ndescription: Run the parity command\n---\n\nBody of the parity command.\n',
    'utf-8',
  );
}

async function makePluginParityPair(): Promise<PluginParityPair> {
  const v1HomeDir = await makeTempDir('kimi-sdk-parity-v1-home-');
  const v2HomeDir = await makeTempDir('kimi-sdk-parity-v2-home-');
  const sourceDir = await makeTempDir('kimi-sdk-parity-plugin-src-');
  await writeFixturePlugin(sourceDir);
  return {
    v1: new SDKRpcClient({ homeDir: v1HomeDir, identity: TEST_IDENTITY }),
    v2: new SDKRpcClientV2({ homeDir: v2HomeDir, identity: TEST_IDENTITY }),
    v1Home: { raw: v1HomeDir, real: await realpath(v1HomeDir) },
    v2Home: { raw: v2HomeDir, real: await realpath(v2HomeDir) },
    sourceDir,
  };
}

async function closePluginPair(pair: PluginParityPair): Promise<void> {
  await pair.v1.close();
  await pair.v2.close();
}

function installFixtureOnBoth(
  pair: PluginParityPair,
): Promise<[PluginSummary, PluginSummary]> {
  return Promise.all([
    pair.v1.installPlugin(pair.sourceDir),
    pair.v2.installPlugin(pair.sourceDir),
  ]);
}

describe('v1↔v2 plugin parity', () => {
  it('installPlugin from a local directory returns the same summary', async () => {
    const pair = await makePluginParityPair();
    try {
      const [v1Summary, v2Summary] = await installFixtureOnBoth(pair);
      expect(normalize(v2Summary, 'id')).toEqual(normalize(v1Summary, 'id'));
      expect(v1Summary).toMatchObject({
        id: FIXTURE_PLUGIN_ID,
        displayName: 'Parity Plugin',
        version: '1.2.3',
        enabled: true,
        state: 'ok',
        skillCount: 1,
        mcpServerCount: 2,
        enabledMcpServerCount: 2,
        hookCount: 1,
        commandCount: 1,
        hasErrors: false,
        source: 'local-path',
      });
    } finally {
      await closePluginPair(pair);
    }
  });

  it('listPlugins returns the same summaries after the same install', async () => {
    const pair = await makePluginParityPair();
    try {
      await installFixtureOnBoth(pair);
      const [v1Plugins, v2Plugins] = await Promise.all([
        pair.v1.listPlugins(),
        pair.v2.listPlugins(),
      ]);
      expect(normalize(v2Plugins, 'id')).toEqual(normalize(v1Plugins, 'id'));
      expect(v1Plugins).toHaveLength(1);
    } finally {
      await closePluginPair(pair);
    }
  });

  it('getPluginInfo returns the same info modulo per-home paths and install stamps', async () => {
    const pair = await makePluginParityPair();
    try {
      await installFixtureOnBoth(pair);
      const [v1Info, v2Info] = await Promise.all([
        pair.v1.getPluginInfo(FIXTURE_PLUGIN_ID),
        pair.v2.getPluginInfo(FIXTURE_PLUGIN_ID),
      ]);
      const project = KNOWN_DIFFS.getPluginInfo;
      expect(project(v2Info, pair.v2Home)).toEqual(project(v1Info, pair.v1Home));
      expect(v1Info.mcpServers.map((server) => server.name)).toEqual([
        'parity-http',
        'parity-stdio',
      ]);
    } finally {
      await closePluginPair(pair);
    }
  });

  it('setPluginEnabled toggles identically on both engines', async () => {
    const pair = await makePluginParityPair();
    try {
      await installFixtureOnBoth(pair);
      await Promise.all([
        pair.v1.setPluginEnabled(FIXTURE_PLUGIN_ID, false),
        pair.v2.setPluginEnabled(FIXTURE_PLUGIN_ID, false),
      ]);
      const [v1Disabled, v2Disabled] = await Promise.all([
        pair.v1.listPlugins(),
        pair.v2.listPlugins(),
      ]);
      expect(normalize(v2Disabled, 'id')).toEqual(normalize(v1Disabled, 'id'));
      expect(v1Disabled[0]?.enabled).toBe(false);
      await Promise.all([
        pair.v1.setPluginEnabled(FIXTURE_PLUGIN_ID, true),
        pair.v2.setPluginEnabled(FIXTURE_PLUGIN_ID, true),
      ]);
      const [v1Enabled, v2Enabled] = await Promise.all([
        pair.v1.listPlugins(),
        pair.v2.listPlugins(),
      ]);
      expect(normalize(v2Enabled, 'id')).toEqual(normalize(v1Enabled, 'id'));
      expect(v1Enabled[0]?.enabled).toBe(true);
    } finally {
      await closePluginPair(pair);
    }
  });

  it('setPluginMcpServerEnabled toggles one server identically on both engines', async () => {
    const pair = await makePluginParityPair();
    try {
      await installFixtureOnBoth(pair);
      await Promise.all([
        pair.v1.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-stdio', false),
        pair.v2.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-stdio', false),
      ]);
      const [v1Info, v2Info] = await Promise.all([
        pair.v1.getPluginInfo(FIXTURE_PLUGIN_ID),
        pair.v2.getPluginInfo(FIXTURE_PLUGIN_ID),
      ]);
      const project = KNOWN_DIFFS.getPluginInfo;
      expect(project(v2Info, pair.v2Home)).toEqual(project(v1Info, pair.v1Home));
      expect(v1Info.enabledMcpServerCount).toBe(1);
      expect(v1Info.mcpServers.find((server) => server.name === 'parity-stdio')?.enabled).toBe(
        false,
      );
    } finally {
      await closePluginPair(pair);
    }
  });

  it('removePlugin leaves both engines with an empty catalog', async () => {
    const pair = await makePluginParityPair();
    try {
      await installFixtureOnBoth(pair);
      await Promise.all([
        pair.v1.removePlugin(FIXTURE_PLUGIN_ID),
        pair.v2.removePlugin(FIXTURE_PLUGIN_ID),
      ]);
      const [v1Plugins, v2Plugins] = await Promise.all([
        pair.v1.listPlugins(),
        pair.v2.listPlugins(),
      ]);
      expect(v2Plugins).toEqual(v1Plugins);
      expect(v1Plugins).toEqual([]);
    } finally {
      await closePluginPair(pair);
    }
  });

  it('reloadPlugins reports no catalog change and re-materializes disk edits identically', async () => {
    const pair = await makePluginParityPair();
    try {
      await installFixtureOnBoth(pair);
      const [v1Reload, v2Reload] = await Promise.all([
        pair.v1.reloadPlugins(),
        pair.v2.reloadPlugins(),
      ]);
      expect(v2Reload).toEqual(v1Reload);
      expect(v1Reload).toEqual({ added: [], removed: [], errors: [] });
      // An out-of-band edit to the managed copy is picked up by the next
      // reload on both engines (reload re-reads the manifest from disk).
      for (const home of [pair.v1Home, pair.v2Home]) {
        const manifestPath = join(
          home.real,
          'plugins',
          'managed',
          FIXTURE_PLUGIN_ID,
          'kimi.plugin.json',
        );
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { version: string };
        manifest.version = '2.0.0';
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      }
      const [v1Reloaded, v2Reloaded] = await Promise.all([
        pair.v1.reloadPlugins(),
        pair.v2.reloadPlugins(),
      ]);
      expect(v2Reloaded).toEqual(v1Reloaded);
      const [v1Plugins, v2Plugins] = await Promise.all([
        pair.v1.listPlugins(),
        pair.v2.listPlugins(),
      ]);
      expect(normalize(v2Plugins, 'id')).toEqual(normalize(v1Plugins, 'id'));
      expect(v1Plugins[0]?.version).toBe('2.0.0');
    } finally {
      await closePluginPair(pair);
    }
  });

  it('listPluginCommands returns the same enabled commands', async () => {
    const pair = await makePluginParityPair();
    const workDir = await makeTempDir('kimi-sdk-parity-work-');
    try {
      await installFixtureOnBoth(pair);
      // The v1 session connects the plugin's enabled MCP servers at creation;
      // disable them first so the test stays offline (the fixture's http
      // server URL is a real-looking host). Commands are unaffected. v1's
      // plugin manager persists without a mutation queue (v2 serializes
      // internally), so same-engine mutations stay sequential here.
      await Promise.all([
        (async () => {
          await pair.v1.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-stdio', false);
          await pair.v1.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-http', false);
        })(),
        (async () => {
          await pair.v2.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-stdio', false);
          await pair.v2.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-http', false);
        })(),
      ]);
      // v1 answers from the session's creation-time snapshot, so the session
      // must be created after the install; v2 ignores the sessionId (app-global
      // live view).
      const session = await pair.v1.createSession({ workDir });
      try {
        const [v1Commands, v2Commands] = await Promise.all([
          pair.v1.listPluginCommands({ sessionId: session.id }),
          pair.v2.listPluginCommands({ sessionId: session.id }),
        ]);
        const project = KNOWN_DIFFS.listPluginCommands;
        expect(normalize(project(v2Commands, pair.v2Home), 'name')).toEqual(
          normalize(project(v1Commands, pair.v1Home), 'name'),
        );
        expect(v1Commands).toHaveLength(1);
        expect(v1Commands[0]).toMatchObject({
          pluginId: FIXTURE_PLUGIN_ID,
          name: 'parity-command',
          description: 'Run the parity command',
          body: 'Body of the parity command.',
        });
      } finally {
        await pair.v1.closeSession({ sessionId: session.id });
      }
    } finally {
      await closePluginPair(pair);
    }
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle parity
//
// The session methods are driven through `SDKRpcClient` / `SDKRpcClientV2`
// directly (same rule as the plugin parity): isolated per-engine homes, one
// SHARED workDir (the sessions live under each home; the workDir is only a
// referenced path, so sharing it makes the workDir / additionalDirs /
// configPath comparisons exact). Explicit session ids keep identity
// comparisons meaningful. No provider calls anywhere — create / resume /
// reload / fork never touch a model. `deleteSession` has no parity case:
// the v2 engine has no session-deletion capability, so the v2 side stays
// not_implemented by design (tracked in `.tmp/v2-migration-tracker.md`).
// ---------------------------------------------------------------------------

interface SessionParityPair {
  readonly v1: SDKRpcClient;
  readonly v2: SDKRpcClientV2;
  readonly v1Home: HomePair;
  readonly v2Home: HomePair;
  readonly workDir: string;
}

async function makeSessionParityPair(configToml?: string): Promise<SessionParityPair> {
  const v1HomeDir = await makeTempDir('kimi-sdk-parity-v1-home-');
  const v2HomeDir = await makeTempDir('kimi-sdk-parity-v2-home-');
  const workDir = await makeTempDir('kimi-sdk-parity-work-');
  if (configToml !== undefined) {
    await writeFile(join(v1HomeDir, 'config.toml'), configToml, 'utf-8');
    await writeFile(join(v2HomeDir, 'config.toml'), configToml, 'utf-8');
  }
  return {
    v1: new SDKRpcClient({ homeDir: v1HomeDir, identity: TEST_IDENTITY }),
    v2: new SDKRpcClientV2({ homeDir: v2HomeDir, identity: TEST_IDENTITY }),
    v1Home: { raw: v1HomeDir, real: await realpath(v1HomeDir) },
    v2Home: { raw: v2HomeDir, real: await realpath(v2HomeDir) },
    workDir,
  };
}

async function closeSessionPair(pair: SessionParityPair): Promise<void> {
  await pair.v1.close();
  await pair.v2.close();
}

/**
 * Give asynchronously-failing turns (model-less prompt/steer/activation
 * launches) a moment to settle before the harnesses close — the failures are
 * engine-internal and not part of the compared surface, but closing
 * mid-failure is a data race the test does not need.
 */
async function settleTurns(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function createOnBoth(
  pair: SessionParityPair,
  input: { readonly id: string; readonly metadata?: JsonObject },
): Promise<void> {
  await Promise.all([
    pair.v1.createSession({ workDir: pair.workDir, ...input }),
    pair.v2.createSession({ workDir: pair.workDir, ...input }),
  ]);
}

/** v2 materializes the main agent lazily (on the cold-resume path) where v1
 *  creates it eagerly; the fork copies the source's agent roster, so close +
 *  cold-resume the source on both engines first to give the fork the same
 *  roster to copy. */
async function materializeMainAgentOnBoth(pair: SessionParityPair, id: string): Promise<void> {
  await Promise.all([pair.v1.closeSession({ sessionId: id }), pair.v2.closeSession({ sessionId: id })]);
  await Promise.all([pair.v1.resumeSession({ id }), pair.v2.resumeSession({ id })]);
}

/**
 * Append one raw record to the main agent's `wire.jsonl` under the given
 * home (both engines lay sessions out as
 * `<home>/sessions/<workdir-key>/<id>/agents/main/wire.jsonl`). Lets a parity
 * fixture feed the SAME wire record through both engines' restore paths.
 */
async function appendMainWireRecord(
  home: HomePair,
  sessionId: string,
  record: JsonObject,
): Promise<void> {
  const sessionsRoot = join(home.raw, 'sessions');
  for (const bucket of await readdir(sessionsRoot)) {
    const wirePath = join(sessionsRoot, bucket, sessionId, 'agents', 'main', 'wire.jsonl');
    try {
      await appendFile(wirePath, JSON.stringify(record) + '\n', 'utf-8');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`wire.jsonl for ${sessionId} not found under ${sessionsRoot}`);
}

describe('v1↔v2 session lifecycle parity', () => {
  it('createSession returns the same summary for the same input', async () => {
    const pair = await makeSessionParityPair();
    const extraDir = await makeTempDir('kimi-sdk-parity-extra-');
    try {
      const input = {
        id: 'session_parity_create',
        workDir: pair.workDir,
        metadata: { origin: 'parity', nested: { n: 1 } },
        additionalDirs: [extraDir],
      } as const;
      const [v1Summary, v2Summary] = await Promise.all([
        pair.v1.createSession(input),
        pair.v2.createSession(input),
      ]);
      const project = KNOWN_DIFFS.createSession;
      expect(project(v2Summary, pair.v2Home)).toEqual(project(v1Summary, pair.v1Home));
      expect(v1Summary.additionalDirs).toEqual([extraDir]);
      expect(v1Summary.metadata).toEqual({ origin: 'parity', nested: { n: 1 } });
      for (const summary of [v1Summary, v2Summary]) {
        expect(typeof summary.createdAt).toBe('number');
        expect(typeof summary.updatedAt).toBe('number');
      }
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('createSession rejects a duplicate id on both engines', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_duplicate' });
      await expect(
        pair.v1.createSession({ id: 'session_parity_duplicate', workDir: pair.workDir }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_ALREADY_EXISTS });
      await expect(
        pair.v2.createSession({ id: 'session_parity_duplicate', workDir: pair.workDir }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_ALREADY_EXISTS });
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('listSessions reflects the same creates and renames across filters', async () => {
    const pair = await makeSessionParityPair();
    const otherWorkDir = await makeTempDir('kimi-sdk-parity-work-other-');
    try {
      await createOnBoth(pair, { id: 'session_parity_one', metadata: { tag: 'one' } });
      await Promise.all([
        pair.v1.createSession({ id: 'session_parity_two', workDir: otherWorkDir }),
        pair.v2.createSession({ id: 'session_parity_two', workDir: otherWorkDir }),
      ]);
      await Promise.all([
        pair.v1.renameSession({ id: 'session_parity_one', title: 'Parity Session One' }),
        pair.v2.renameSession({ id: 'session_parity_one', title: 'Parity Session One' }),
      ]);
      const project = KNOWN_DIFFS.listSessions;
      const [v1All, v2All] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      expect(normalize(project(v2All, pair.v2Home), 'id')).toEqual(
        normalize(project(v1All, pair.v1Home), 'id'),
      );
      expect(v1All).toHaveLength(2);
      const [v1Filtered, v2Filtered] = await Promise.all([
        pair.v1.listSessions({ workDir: pair.workDir }),
        pair.v2.listSessions({ workDir: pair.workDir }),
      ]);
      expect(normalize(project(v2Filtered, pair.v2Home), 'id')).toEqual(
        normalize(project(v1Filtered, pair.v1Home), 'id'),
      );
      expect(v1Filtered.map((summary) => summary.id)).toEqual(['session_parity_one']);
      const [v1ById, v2ById] = await Promise.all([
        pair.v1.listSessions({ sessionId: 'session_parity_two' }),
        pair.v2.listSessions({ sessionId: 'session_parity_two' }),
      ]);
      expect(normalize(project(v2ById, pair.v2Home), 'id')).toEqual(
        normalize(project(v1ById, pair.v1Home), 'id'),
      );
      expect(v1ById.map((summary) => summary.id)).toEqual(['session_parity_two']);
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('renameSession renames a closed session and rejects an empty title on both engines', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_rename' });
      await Promise.all([
        pair.v1.closeSession({ sessionId: 'session_parity_rename' }),
        pair.v2.closeSession({ sessionId: 'session_parity_rename' }),
      ]);
      await Promise.all([
        pair.v1.renameSession({ id: 'session_parity_rename', title: 'Renamed After Close' }),
        pair.v2.renameSession({ id: 'session_parity_rename', title: 'Renamed After Close' }),
      ]);
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      const project = KNOWN_DIFFS.listSessions;
      expect(normalize(project(v2List, pair.v2Home), 'id')).toEqual(
        normalize(project(v1List, pair.v1Home), 'id'),
      );
      // An explicit title compares in full (no projection involved).
      expect(v1List[0]?.title).toBe('Renamed After Close');
      expect(v2List[0]?.title).toBe('Renamed After Close');
      await expect(
        pair.v1.renameSession({ id: 'session_parity_rename', title: '   ' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_TITLE_EMPTY });
      await expect(
        pair.v2.renameSession({ id: 'session_parity_rename', title: '   ' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_TITLE_EMPTY });
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('closeSession keeps the session listed and is idempotent', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_close' });
      await Promise.all([
        pair.v1.closeSession({ sessionId: 'session_parity_close' }),
        pair.v2.closeSession({ sessionId: 'session_parity_close' }),
      ]);
      const project = KNOWN_DIFFS.listSessions;
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      expect(normalize(project(v2List, pair.v2Home), 'id')).toEqual(
        normalize(project(v1List, pair.v1Home), 'id'),
      );
      expect(v1List).toHaveLength(1);
      // Closing an already-closed session is a no-op on both engines.
      await Promise.all([
        pair.v1.closeSession({ sessionId: 'session_parity_close' }),
        pair.v2.closeSession({ sessionId: 'session_parity_close' }),
      ]);
      const [v1Again, v2Again] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      expect(normalize(project(v2Again, pair.v2Home), 'id')).toEqual(
        normalize(project(v1Again, pair.v1Home), 'id'),
      );
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('forkSession copies the session with merged metadata on both engines', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, {
        id: 'session_parity_source',
        metadata: { origin: 'source', shared: 'source' },
      });
      // See materializeMainAgentOnBoth: v2's main agent is lazy, so
      // materialize it on the source first.
      await materializeMainAgentOnBoth(pair, 'session_parity_source');
      const input = {
        id: 'session_parity_source',
        forkId: 'session_parity_fork',
        title: 'Parity Fork',
        metadata: { fork: 'yes', shared: 'fork' },
      } as const;
      const [v1Fork, v2Fork] = await Promise.all([
        pair.v1.forkSession(input),
        pair.v2.forkSession(input),
      ]);
      const project = KNOWN_DIFFS.forkSession;
      expect(project(v2Fork as ResumedSessionSummary, pair.v2Home)).toEqual(
        project(v1Fork as ResumedSessionSummary, pair.v1Home),
      );
      // The fork merges source and caller custom metadata (goal excluded).
      expect(v1Fork.metadata).toEqual({ origin: 'source', shared: 'fork', fork: 'yes' });
      expect(v2Fork.metadata).toEqual({ origin: 'source', shared: 'fork', fork: 'yes' });
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      const projectList = KNOWN_DIFFS.listSessions;
      expect(normalize(projectList(v2List, pair.v2Home), 'id')).toEqual(
        normalize(projectList(v1List, pair.v1Home), 'id'),
      );
      expect(v1List.map((summary) => summary.id).toSorted()).toEqual([
        'session_parity_fork',
        'session_parity_source',
      ]);
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('resumeSession returns the same session state modulo the pinned agents gap', async () => {
    const pair = await makeSessionParityPair();
    const extraDir = await makeTempDir('kimi-sdk-parity-extra-');
    try {
      await createOnBoth(pair, {
        id: 'session_parity_resume',
        metadata: { origin: 'resume' },
      });
      await Promise.all([
        pair.v1.closeSession({ sessionId: 'session_parity_resume' }),
        pair.v2.closeSession({ sessionId: 'session_parity_resume' }),
      ]);
      // Caller-provided additional dirs re-resolve on resume on both engines.
      const [v1Resumed, v2Resumed] = await Promise.all([
        pair.v1.resumeSession({ id: 'session_parity_resume', additionalDirs: [extraDir] }),
        pair.v2.resumeSession({ id: 'session_parity_resume', additionalDirs: [extraDir] }),
      ]);
      const project = KNOWN_DIFFS.resumeSession;
      expect(project(v2Resumed, pair.v2Home)).toEqual(project(v1Resumed, pair.v1Home));
      // Both engines return the per-agent snapshot of the restored main agent.
      expect(Object.keys(v1Resumed.agents)).toEqual(['main']);
      expect(Object.keys(v2Resumed.agents)).toEqual(['main']);
      expect(v1Resumed.additionalDirs).toEqual([extraDir]);
      expect(v2Resumed.additionalDirs).toEqual([extraDir]);
      await expect(pair.v1.resumeSession({ id: 'session_missing' })).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
      await expect(pair.v2.resumeSession({ id: 'session_missing' })).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('reloadSession re-materializes a live session identically', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, {
        id: 'session_parity_reload',
        metadata: { origin: 'reload' },
      });
      const [v1Resumed, v2Resumed] = await Promise.all([
        pair.v1.reloadSession({ sessionId: 'session_parity_reload' }),
        pair.v2.reloadSession({ sessionId: 'session_parity_reload' }),
      ]);
      const project = KNOWN_DIFFS.reloadSession;
      expect(project(v2Resumed, pair.v2Home)).toEqual(project(v1Resumed, pair.v1Home));
      expect(Object.keys(v1Resumed.agents)).toEqual(['main']);
      expect(Object.keys(v2Resumed.agents)).toEqual(['main']);
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('updateSessionMetadata merges into the custom map on both engines', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, {
        id: 'session_parity_metadata',
        metadata: { a: '1', shared: 'old' },
      });
      await Promise.all([
        pair.v1.updateSessionMetadata({
          sessionId: 'session_parity_metadata',
          metadata: { b: '2', shared: 'new' },
        }),
        pair.v2.updateSessionMetadata({
          sessionId: 'session_parity_metadata',
          metadata: { b: '2', shared: 'new' },
        }),
      ]);
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      const project = KNOWN_DIFFS.listSessions;
      expect(normalize(project(v2List, pair.v2Home), 'id')).toEqual(
        normalize(project(v1List, pair.v1Home), 'id'),
      );
      expect(v1List[0]?.metadata).toEqual({ a: '1', b: '2', shared: 'new' });
      expect(v2List[0]?.metadata).toEqual({ a: '1', b: '2', shared: 'new' });
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('addAdditionalDir returns the same result for persist and non-persist', async () => {
    const pair = await makeSessionParityPair();
    const persistedDir = await makeTempDir('kimi-sdk-parity-extra-persisted-');
    const sessionOnlyDir = await makeTempDir('kimi-sdk-parity-extra-session-');
    try {
      await createOnBoth(pair, { id: 'session_parity_adddir' });
      // Both engines read and write the SAME workspace local config (shared
      // workDir), so same-file mutations stay sequential — v1's write is not
      // serialized against v2's read (same lesson as the plugin manager).
      const v1Persisted = await pair.v1.addAdditionalDir({
        id: 'session_parity_adddir',
        path: persistedDir,
        persist: true,
      });
      const v2Persisted = await pair.v2.addAdditionalDir({
        id: 'session_parity_adddir',
        path: persistedDir,
        persist: true,
      });
      expect(v2Persisted).toEqual(v1Persisted);
      expect(v1Persisted).toMatchObject({
        additionalDirs: [persistedDir],
        projectRoot: pair.workDir,
        configPath: join(pair.workDir, '.kimi-code', 'local.toml'),
        persisted: true,
      });
      const v1SessionOnly = await pair.v1.addAdditionalDir({
        id: 'session_parity_adddir',
        path: sessionOnlyDir,
        persist: false,
      });
      const v2SessionOnly = await pair.v2.addAdditionalDir({
        id: 'session_parity_adddir',
        path: sessionOnlyDir,
        persist: false,
      });
      expect(v2SessionOnly).toEqual(v1SessionOnly);
      expect(v1SessionOnly).toMatchObject({
        additionalDirs: [persistedDir, sessionOnlyDir],
        persisted: false,
      });
      // v1 requires the active session on both engines.
      await expect(
        pair.v1.addAdditionalDir({ id: 'session_missing', path: persistedDir, persist: true }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        pair.v2.addAdditionalDir({ id: 'session_missing', path: persistedDir, persist: true }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    } finally {
      await closeSessionPair(pair);
    }
  });
});

// ---------------------------------------------------------------------------
// Agent interaction parity
//
// Same driving rule as the session/plugin batches: `SDKRpcClient` /
// `SDKRpcClientV2` directly, isolated per-engine homes, one SHARED workDir,
// explicit session ids. Every case here needs a configured default model
// (v1 applies it to the main agent eagerly at createSession; the v2 SDK
// binds the default profile on first agent touch), so both homes get
// AGENT_CONFIG_TOML before the clients are constructed. No provider calls:
// the fixture providers are never asked for a completion — compaction's
// success path is the one method that would fire a real summarizer round,
// so its parity stops at the pre-provider rejection (pinned below and in
// the migration tracker).
// ---------------------------------------------------------------------------

/**
 * Agent fixture: a kimi-typed provider (strict thinking validation on both
 * engines) whose default model declares a thinking effort list, plus a
 * second provider/model for the setModel switch case.
 */
const AGENT_CONFIG_TOML = `
default_provider = "fixture-provider"
default_model = "fixture-model"
default_permission_mode = "auto"

[providers.fixture-provider]
type = "kimi"
api_key = "fixture-api-key"
base_url = "https://example.com/v1"

[providers.second-provider]
type = "openai"
api_key = "second-api-key"

[models.fixture-model]
provider = "fixture-provider"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["thinking"]
support_efforts = ["low", "high"]
default_effort = "high"

[models.second-model]
provider = "second-provider"
model = "second-brain"
max_context_size = 128000
`;

async function makeAgentParityPair(configToml: string = AGENT_CONFIG_TOML): Promise<SessionParityPair> {
  const v1HomeDir = await makeTempDir('kimi-sdk-parity-v1-home-');
  const v2HomeDir = await makeTempDir('kimi-sdk-parity-v2-home-');
  const workDir = await makeTempDir('kimi-sdk-parity-work-');
  await writeFile(join(v1HomeDir, 'config.toml'), configToml, 'utf-8');
  await writeFile(join(v2HomeDir, 'config.toml'), configToml, 'utf-8');
  return {
    v1: new SDKRpcClient({ homeDir: v1HomeDir, identity: TEST_IDENTITY }),
    v2: new SDKRpcClientV2({ homeDir: v2HomeDir, identity: TEST_IDENTITY }),
    v1Home: { raw: v1HomeDir, real: await realpath(v1HomeDir) },
    v2Home: { raw: v2HomeDir, real: await realpath(v2HomeDir) },
    workDir,
  };
}

describe('v1↔v2 agent interaction parity', () => {
  it('getStatus / getContext / getUsage / getPlan match on a fresh session', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_fresh' });
      const input = { sessionId: 'session_parity_agent_fresh' } as const;
      const [v1Status, v2Status] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(normalize(v2Status, '')).toEqual(normalize(v1Status, ''));
      // The eager-default state both engines arrive at from the fixture:
      // default model + its default effort + the configured permission mode.
      expect(v1Status).toEqual({
        model: 'fixture-model',
        thinkingEffort: 'high',
        permission: 'auto',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 262144,
        contextUsage: 0,
        usage: undefined,
      });
      const [v1Context, v2Context] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      const projectContext = KNOWN_DIFFS.getContext;
      expect(projectContext(v2Context)).toEqual(projectContext(v1Context));
      expect(v1Context).toEqual({ history: [], tokenCount: 0 });
      const [v1Usage, v2Usage] = await Promise.all([
        pair.v1.getUsage(input),
        pair.v2.getUsage(input),
      ]);
      expect(normalize(v2Usage, '')).toEqual(normalize(v1Usage, ''));
      const [v1Plan, v2Plan] = await Promise.all([
        pair.v1.getPlan(input),
        pair.v2.getPlan(input),
      ]);
      expect(v2Plan).toEqual(v1Plan);
      expect(v1Plan).toBeNull();
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('getStatus matches on a home with no config at all (model-less session)', async () => {
    const restoreEnv = scrubConfigEnv();
    // No config.toml on either side: v1's eager main agent has no model; the
    // v2 SDK leaves the main agent unbound (its bind swallows
    // model.not_configured) — the two read back identically.
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_noconfig' });
      const input = { sessionId: 'session_parity_agent_noconfig' } as const;
      const [v1Status, v2Status] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(normalize(v2Status, '')).toEqual(normalize(v1Status, ''));
      expect(v1Status).toEqual({
        model: undefined,
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
        usage: undefined,
      });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('setModel returns the resolved provider and switches models identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_setmodel' });
      const input = { sessionId: 'session_parity_agent_setmodel' } as const;
      const [v1Set, v2Set] = await Promise.all([
        pair.v1.setModel({ ...input, model: 'second-model' }),
        pair.v2.setModel({ ...input, model: 'second-model' }),
      ]);
      expect(v2Set).toEqual(v1Set);
      expect(v1Set).toEqual({ model: 'second-model', providerName: 'second-provider' });
      const [v1Status, v2Status] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(normalize(v2Status, '')).toEqual(normalize(v1Status, ''));
      expect(v1Status.model).toBe('second-model');
      expect(v1Status.maxContextTokens).toBe(128000);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('setModel rejects an unknown alias with the same code on both engines', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_setmodel_bad' });
      const input = { sessionId: 'session_parity_agent_setmodel_bad', model: 'missing-model' };
      // Both validate the alias up front and reject `config.invalid`; only
      // the trailing guidance differs (v1 names the missing section).
      const rejection = 'Model "missing-model" is not configured in config.toml.';
      await expect(pair.v1.setModel(input)).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      });
      await expect(pair.v1.setModel(input)).rejects.toThrowError(rejection);
      await expect(pair.v2.setModel(input)).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      });
      await expect(pair.v2.setModel(input)).rejects.toThrowError(rejection);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('setThinking applies and rejects unlisted efforts identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_thinking' });
      const input = { sessionId: 'session_parity_agent_thinking' } as const;
      await Promise.all([
        pair.v1.setThinking({ ...input, effort: 'low' }),
        pair.v2.setThinking({ ...input, effort: 'low' }),
      ]);
      const [v1Low, v2Low] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(normalize(v2Low, '')).toEqual(normalize(v1Low, ''));
      expect(v1Low.thinkingEffort).toBe('low');
      // An unlisted effort on a strict-thinking (kimi-typed) model rejects
      // with the same code AND the same message on both engines.
      const rejection =
        'Thinking effort "bogus" is not supported by model "fixture-model". ' +
        'Supported efforts: off, low, high.';
      await expect(pair.v1.setThinking({ ...input, effort: 'bogus' })).rejects.toMatchObject({
        code: ErrorCodes.MODEL_CONFIG_INVALID,
      });
      await expect(pair.v1.setThinking({ ...input, effort: 'bogus' })).rejects.toThrowError(
        rejection,
      );
      await expect(pair.v2.setThinking({ ...input, effort: 'bogus' })).rejects.toMatchObject({
        code: ErrorCodes.MODEL_CONFIG_INVALID,
      });
      await expect(pair.v2.setThinking({ ...input, effort: 'bogus' })).rejects.toThrowError(
        rejection,
      );
      await Promise.all([
        pair.v1.setThinking({ ...input, effort: 'off' }),
        pair.v2.setThinking({ ...input, effort: 'off' }),
      ]);
      const [v1Off, v2Off] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(normalize(v2Off, '')).toEqual(normalize(v1Off, ''));
      expect(v1Off.thinkingEffort).toBe('off');
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('setPermission flips the mode on both engines', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_permission' });
      const input = { sessionId: 'session_parity_agent_permission' } as const;
      await Promise.all([
        pair.v1.setPermission({ ...input, mode: 'yolo' }),
        pair.v2.setPermission({ ...input, mode: 'yolo' }),
      ]);
      const [v1Yolo, v2Yolo] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(normalize(v2Yolo, '')).toEqual(normalize(v1Yolo, ''));
      expect(v1Yolo.permission).toBe('yolo');
      await Promise.all([
        pair.v1.setPermission({ ...input, mode: 'manual' }),
        pair.v2.setPermission({ ...input, mode: 'manual' }),
      ]);
      const [v1Manual, v2Manual] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(normalize(v2Manual, '')).toEqual(normalize(v1Manual, ''));
      expect(v1Manual.permission).toBe('manual');
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('plan mode lifecycle matches: enter / getPlan / write / clear / cancel', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_plan' });
      const input = { sessionId: 'session_parity_agent_plan' } as const;
      await Promise.all([
        pair.v1.setPlanMode({ ...input, enabled: true }),
        pair.v2.setPlanMode({ ...input, enabled: true }),
      ]);
      const [v1Plan, v2Plan] = await Promise.all([
        pair.v1.getPlan(input),
        pair.v2.getPlan(input),
      ]);
      const projectPlan = KNOWN_DIFFS.getPlan;
      expect(projectPlan(v2Plan, pair.v2Home)).toEqual(projectPlan(v1Plan, pair.v1Home));
      expect(v1Plan?.id.length).toBeGreaterThan(0);
      expect(v2Plan?.id.length).toBeGreaterThan(0);
      expect(v1Plan?.content).toBe('');
      const [v1Status, v2Status] = await Promise.all([
        pair.v1.getStatus(input),
        pair.v2.getStatus(input),
      ]);
      expect(v1Status.planMode).toBe(true);
      expect(v2Status.planMode).toBe(true);
      // Plan content round-trips through the plan file on both engines.
      expect(v1Plan).not.toBeNull();
      expect(v2Plan).not.toBeNull();
      await writeFile(v1Plan!.path, '# Parity plan', 'utf-8');
      await writeFile(v2Plan!.path, '# Parity plan', 'utf-8');
      const [v1Filled, v2Filled] = await Promise.all([
        pair.v1.getPlan(input),
        pair.v2.getPlan(input),
      ]);
      expect(projectPlan(v2Filled, pair.v2Home)).toEqual(projectPlan(v1Filled, pair.v1Home));
      expect(v1Filled?.content).toBe('# Parity plan');
      await Promise.all([pair.v1.clearPlan(input), pair.v2.clearPlan(input)]);
      const [v1Cleared, v2Cleared] = await Promise.all([
        pair.v1.getPlan(input),
        pair.v2.getPlan(input),
      ]);
      expect(projectPlan(v2Cleared, pair.v2Home)).toEqual(projectPlan(v1Cleared, pair.v1Home));
      expect(v1Cleared?.content).toBe('');
      // A second enter while active rejects with the same plain error.
      await expect(pair.v1.setPlanMode({ ...input, enabled: true })).rejects.toThrowError(
        'Already in plan mode',
      );
      await expect(pair.v2.setPlanMode({ ...input, enabled: true })).rejects.toThrowError(
        'Already in plan mode',
      );
      await Promise.all([
        pair.v1.setPlanMode({ ...input, enabled: false }),
        pair.v2.setPlanMode({ ...input, enabled: false }),
      ]);
      const [v1Off, v2Off] = await Promise.all([
        pair.v1.getPlan(input),
        pair.v2.getPlan(input),
      ]);
      expect(v2Off).toEqual(v1Off);
      expect(v1Off).toBeNull();
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('importContext appends the byte-identical message and validates identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_import' });
      const input = { sessionId: 'session_parity_agent_import' } as const;
      await Promise.all([
        pair.v1.importContext({ ...input, content: 'Earlier user: keep the API stable.', source: "file 'notes.md'" }),
        pair.v2.importContext({ ...input, content: 'Earlier user: keep the API stable.', source: "file 'notes.md'" }),
      ]);
      const [v1Context, v2Context] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      // Histories are byte-identical (same wrapper, same wire record).
      expect(normalize(v2Context.history, '')).toEqual(normalize(v1Context.history, ''));
      expect(v1Context.history).toHaveLength(1);
      expect(v1Context.history[0]).toMatchObject({ role: 'user', origin: { kind: 'user' } });
      // Both engines estimate an in-memory import with the same
      // `estimateTokensForMessages`, so post-import counts match exactly.
      // (They diverge again once the provider reports measured usage — see
      // KNOWN_DIFFS.getContext.)
      expect(v1Context.tokenCount).toBeGreaterThan(0);
      expect(v2Context.tokenCount).toBe(v1Context.tokenCount);
      // v1's validations, replicated on the v2 side.
      await expect(
        pair.v1.importContext({ ...input, content: ' \n\t ', source: "file 'empty.md'" }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(
        pair.v2.importContext({ ...input, content: ' \n\t ', source: "file 'empty.md'" }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(
        pair.v1.importContext({ ...input, content: 'x', source: '  ' }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(
        pair.v2.importContext({ ...input, content: 'x', source: '  ' }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      // A second import appends.
      await Promise.all([
        pair.v1.importContext({ ...input, content: 'Second import.', source: "session 'old'" }),
        pair.v2.importContext({ ...input, content: 'Second import.', source: "session 'old'" }),
      ]);
      const [v1After, v2After] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      expect(normalize(v2After.history, '')).toEqual(normalize(v1After.history, ''));
      expect(v1After.history).toHaveLength(2);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('importContext rejects an overflowing import with context.overflow on both engines', async () => {
    const restoreEnv = scrubConfigEnv();
    const tinyConfig = AGENT_CONFIG_TOML.replace('max_context_size = 262144', 'max_context_size = 16');
    const pair = await makeAgentParityPair(tinyConfig);
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_import_overflow' });
      const input = {
        sessionId: 'session_parity_agent_import_overflow',
        content: 'This import is far too large for the tiny fixture context window.',
        source: "file 'big.md'",
      } as const;
      await expect(pair.v1.importContext(input)).rejects.toMatchObject({
        code: ErrorCodes.CONTEXT_OVERFLOW,
      });
      await expect(pair.v2.importContext(input)).rejects.toMatchObject({
        code: ErrorCodes.CONTEXT_OVERFLOW,
      });
      // Neither engine appended anything.
      const [v1Context, v2Context] = await Promise.all([
        pair.v1.getContext({ sessionId: input.sessionId }),
        pair.v2.getContext({ sessionId: input.sessionId }),
      ]);
      expect(normalize(v2Context, '')).toEqual(normalize(v1Context, ''));
      expect(v1Context.history).toHaveLength(0);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('resumeSession replays the same per-agent history and state snapshot', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_resume_replay' });
      const input = { sessionId: 'session_parity_resume_replay' } as const;
      // History without a single provider call: an import, a mode switch to a
      // NON-default mode (v1 journals even an unchanged setMode where v2
      // dedupes — a distinct mode records on both), plan mode, a goal
      // lifecycle, and a shell command.
      await Promise.all([
        pair.v1.importContext({ ...input, content: 'Resume replay import.', source: "file 'r.md'" }),
        pair.v2.importContext({ ...input, content: 'Resume replay import.', source: "file 'r.md'" }),
      ]);
      // v2's context append journals through the agent's activity lane and
      // can land after a subsequent immediate-write record; let it settle so
      // both wires record the same order.
      await settleTurns();
      await Promise.all([
        pair.v1.setPermission({ ...input, mode: 'manual' }),
        pair.v2.setPermission({ ...input, mode: 'manual' }),
      ]);
      await Promise.all([
        pair.v1.setPlanMode({ ...input, enabled: true }),
        pair.v2.setPlanMode({ ...input, enabled: true }),
      ]);
      await Promise.all([
        pair.v1.createGoal({ ...input, objective: 'resume replay goal' }),
        pair.v2.createGoal({ ...input, objective: 'resume replay goal' }),
      ]);
      // Pause before close: an ACTIVE goal is demoted by the resume itself
      // (v2 journals the demote op, v1 logs it live post-replay), which is a
      // legitimate resume-time divergence this fixture does not exercise.
      await Promise.all([pair.v1.pauseGoal(input), pair.v2.pauseGoal(input)]);
      const [v1Shell, v2Shell] = await Promise.all([
        pair.v1.runShellCommand({ ...input, command: 'echo parity-resume' }),
        pair.v2.runShellCommand({ ...input, command: 'echo parity-resume' }),
      ]);
      expect(v2Shell).toEqual(v1Shell);
      await Promise.all([
        pair.v1.closeSession(input),
        pair.v2.closeSession(input),
      ]);
      // The same tool-store record through both restore paths (the TUI's
      // todo panel reads `toolStore['todo']`).
      const todoRecord: JsonObject = {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'parity todo', status: 'pending' }],
        time: Date.now(),
      };
      await appendMainWireRecord(pair.v1Home, input.sessionId, todoRecord);
      await appendMainWireRecord(pair.v2Home, input.sessionId, todoRecord);

      const [v1Resumed, v2Resumed] = await Promise.all([
        pair.v1.resumeSession({ id: input.sessionId }),
        pair.v2.resumeSession({ id: input.sessionId }),
      ]);
      const project = KNOWN_DIFFS.resumeSession;
      expect(project(v2Resumed, pair.v2Home)).toEqual(project(v1Resumed, pair.v1Home));
      // The projections, made explicit: identical replay type sequences once
      // the bind-time `config_updated` entries drop out of v1's, identical
      // message contents, and the injected todo store on both sides.
      const v1Agent = v1Resumed.agents['main']!;
      const v2Agent = v2Resumed.agents['main']!;
      expect(v2Agent.replay.map((record) => record.type)).toEqual(
        v1Agent.replay.filter((record) => record.type !== 'config_updated').map((record) => record.type),
      );
      expect(v2Agent.replay.map((record) => record.type)).toEqual([
        'permission_updated',
        'message',
        'permission_updated',
        'plan_updated',
        'goal_updated',
        'goal_updated',
        'message',
        'message',
      ]);
      const v1Messages = v1Agent.replay.flatMap((record) =>
        record.type === 'message' ? [record.message] : [],
      );
      const v2Messages = v2Agent.replay.flatMap((record) =>
        record.type === 'message' ? [record.message] : [],
      );
      expect(normalize(v2Messages, '')).toEqual(normalize(v1Messages, ''));
      expect(v1Messages).toHaveLength(3);
      expect(v2Agent.toolStore).toEqual(v1Agent.toolStore);
      expect(v1Agent.toolStore).toEqual({
        todo: [{ title: 'parity todo', status: 'pending' }],
      });
      expect(v2Agent.background).toEqual([]);
      expect(v1Agent.background).toEqual([]);

      // replayTurnLimit trims both replays to the most recent N user turns
      // (the shell command's input line is the last turn boundary here).
      const [v1Limited, v2Limited] = await Promise.all([
        pair.v1.resumeSession({ id: input.sessionId, replayTurnLimit: 1 }),
        pair.v2.resumeSession({ id: input.sessionId, replayTurnLimit: 1 }),
      ]);
      expect(project(v2Limited, pair.v2Home)).toEqual(project(v1Limited, pair.v1Home));
      const v1LimitedTypes = v1Limited.agents['main']!.replay.map((record) => record.type);
      expect(v1LimitedTypes).toEqual(['message', 'message']);
      expect(v2Limited.agents['main']!.replay.map((record) => record.type)).toEqual(
        v1LimitedTypes,
      );
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('clearContext empties both histories', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_clear' });
      const input = { sessionId: 'session_parity_agent_clear' } as const;
      await Promise.all([
        pair.v1.importContext({ ...input, content: 'To be cleared.', source: "file 'x.md'" }),
        pair.v2.importContext({ ...input, content: 'To be cleared.', source: "file 'x.md'" }),
      ]);
      await Promise.all([pair.v1.clearContext(input), pair.v2.clearContext(input)]);
      const [v1Context, v2Context] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      expect(normalize(v2Context, '')).toEqual(normalize(v1Context, ''));
      expect(v1Context).toEqual({ history: [], tokenCount: 0 });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('undoHistory removes the same turn suffix', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_undo' });
      const input = { sessionId: 'session_parity_agent_undo' } as const;
      await Promise.all([
        pair.v1.importContext({ ...input, content: 'First import.', source: "file 'one.md'" }),
        pair.v2.importContext({ ...input, content: 'First import.', source: "file 'one.md'" }),
      ]);
      await Promise.all([
        pair.v1.importContext({ ...input, content: 'Second import.', source: "file 'two.md'" }),
        pair.v2.importContext({ ...input, content: 'Second import.', source: "file 'two.md'" }),
      ]);
      await Promise.all([
        pair.v1.undoHistory({ ...input, count: 1 }),
        pair.v2.undoHistory({ ...input, count: 1 }),
      ]);
      const projectContext = KNOWN_DIFFS.getContext;
      const [v1OneLeft, v2OneLeft] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      expect(projectContext(v2OneLeft)).toEqual(projectContext(v1OneLeft));
      expect(v1OneLeft.history).toHaveLength(1);
      await Promise.all([
        pair.v1.undoHistory({ ...input, count: 1 }),
        pair.v2.undoHistory({ ...input, count: 1 }),
      ]);
      const [v1Empty, v2Empty] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      expect(normalize(v2Empty, '')).toEqual(normalize(v1Empty, ''));
      expect(v1Empty.history).toHaveLength(0);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('undoHistory failure modes differ as pinned (v1 partial + request.invalid, v2 atomic session.undo_unavailable)', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_undo_fail' });
      const input = { sessionId: 'session_parity_agent_undo_fail' } as const;
      // Empty history: v1 is a silent no-op, v2 rejects atomically.
      await pair.v1.undoHistory({ ...input, count: 1 });
      await expect(pair.v2.undoHistory({ ...input, count: 1 })).rejects.toMatchObject({
        code: 'session.undo_unavailable',
      });
      await Promise.all([
        pair.v1.importContext({ ...input, content: 'Only turn.', source: "file 'one.md'" }),
        pair.v2.importContext({ ...input, content: 'Only turn.', source: "file 'one.md'" }),
      ]);
      // More than available: v1 splices the partial suffix out of the live
      // history and THEN throws request.invalid; v2 prechecks and rejects
      // with session.undo_unavailable without touching the history.
      await expect(pair.v1.undoHistory({ ...input, count: 2 })).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
      });
      await expect(pair.v2.undoHistory({ ...input, count: 2 })).rejects.toMatchObject({
        code: 'session.undo_unavailable',
      });
      const [v1Context, v2Context] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      expect(v1Context.history).toHaveLength(0);
      expect(v2Context.history).toHaveLength(1);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('compact rejects on an empty history; cancelCompaction is an idle no-op', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_compact' });
      const input = { sessionId: 'session_parity_agent_compact' } as const;
      // The manual-compaction success path fires a real summarizer round on
      // both engines, so parity stops at the pre-provider rejection (no
      // history → compaction.unable); the success path is registered as
      // provider-boundary-only in the migration tracker.
      await expect(pair.v1.compact(input)).rejects.toMatchObject({
        code: ErrorCodes.COMPACTION_UNABLE,
      });
      await expect(pair.v2.compact(input)).rejects.toMatchObject({
        code: ErrorCodes.COMPACTION_UNABLE,
      });
      await pair.v1.cancelCompaction(input);
      await pair.v2.cancelCompaction(input);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('createSession applies model / thinking / permission to the main agent', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      const input = {
        id: 'session_parity_agent_create_opts',
        workDir: pair.workDir,
        model: 'fixture-model',
        thinking: 'low',
        permission: 'yolo',
      } as const;
      await Promise.all([pair.v1.createSession(input), pair.v2.createSession(input)]);
      const statusInput = { sessionId: input.id } as const;
      const [v1Status, v2Status] = await Promise.all([
        pair.v1.getStatus(statusInput),
        pair.v2.getStatus(statusInput),
      ]);
      expect(normalize(v2Status, '')).toEqual(normalize(v1Status, ''));
      expect(v1Status).toMatchObject({
        model: 'fixture-model',
        thinkingEffort: 'low',
        permission: 'yolo',
      });
      // v1 never validates the create-time effort: an unlisted value
      // normalizes to the model default. The v2 bind (deliberately
      // non-strict) resolves it the same way.
      const drifted = {
        id: 'session_parity_agent_create_drift',
        workDir: pair.workDir,
        thinking: 'bogus',
      } as const;
      await Promise.all([pair.v1.createSession(drifted), pair.v2.createSession(drifted)]);
      const [v1Drift, v2Drift] = await Promise.all([
        pair.v1.getStatus({ sessionId: drifted.id }),
        pair.v2.getStatus({ sessionId: drifted.id }),
      ]);
      expect(normalize(v2Drift, '')).toEqual(normalize(v1Drift, ''));
      expect(v1Drift.thinkingEffort).toBe('high');
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('createSession with an unknown model: v1 records it, v2 rejects up front (pinned)', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      // Pinned difference: v1 records an unknown alias at create without
      // resolving it (the failure defers to the first prompt); v2's bind
      // resolves through the model catalog up front and rejects — with the
      // same `config.invalid` code setModel uses.
      await expect(
        pair.v1.createSession({
          id: 'session_parity_agent_create_bad',
          workDir: pair.workDir,
          model: 'missing-model',
        }),
      ).resolves.toMatchObject({ id: 'session_parity_agent_create_bad' });
      await expect(
        pair.v2.createSession({
          id: 'session_parity_agent_create_bad',
          workDir: pair.workDir,
          model: 'missing-model',
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('agent-scoped calls reject an unknown agent id identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_ghost' });
      const input = { sessionId: 'session_parity_agent_ghost' } as const;
      await expect(
        pair.v1.withInteractiveAgent('ghost', () => pair.v1.getStatus(input)),
      ).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_FOUND });
      await expect(
        pair.v2.withInteractiveAgent('ghost', () => pair.v2.getStatus(input)),
      ).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_FOUND });
      await expect(
        pair.v1.withInteractiveAgent('ghost', () =>
          pair.v1.setModel({ ...input, model: 'fixture-model' }),
        ),
      ).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_FOUND });
      await expect(
        pair.v2.withInteractiveAgent('ghost', () =>
          pair.v2.setModel({ ...input, model: 'fixture-model' }),
        ),
      ).rejects.toMatchObject({ code: ErrorCodes.AGENT_NOT_FOUND });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('runShellCommand executes and records identically; cancelShellCommand is a silent no-op', async () => {
    const restoreEnv = scrubConfigEnv();
    // Configured home: v1 only assembles its builtin tools on a profiled
    // agent, so a model-less v1 session answers "Bash tool is not
    // available." where v2 runs the command (not pinned — the fixture simply
    // needs a bound model on both sides). Shell commands never start a turn,
    // so this stays pre-provider.
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_shell' });
      const input = { sessionId: 'session_parity_agent_shell' } as const;
      const [v1Shell, v2Shell] = await Promise.all([
        pair.v1.runShellCommand({ ...input, command: 'echo out; echo err >&2', commandId: 'cmd-mixed' }),
        pair.v2.runShellCommand({ ...input, command: 'echo out; echo err >&2', commandId: 'cmd-mixed' }),
      ]);
      expect(v2Shell).toEqual(v1Shell);
      expect(v1Shell).toEqual({ stdout: 'out\n', stderr: 'err\n', isError: false });
      const [v1Exit, v2Exit] = await Promise.all([
        pair.v1.runShellCommand({ ...input, command: 'exit 3' }),
        pair.v2.runShellCommand({ ...input, command: 'exit 3' }),
      ]);
      expect(v2Exit).toEqual(v1Exit);
      expect(v1Exit).toEqual({
        stdout: '',
        stderr: 'Process exited with code 3\nCommand failed with exit code: 3.',
        isError: true,
      });
      // Cancelling an unknown command id is a silent no-op on both engines.
      await Promise.all([
        pair.v1.cancelShellCommand({ ...input, commandId: 'never-started' }),
        pair.v2.cancelShellCommand({ ...input, commandId: 'never-started' }),
      ]);
      // The recorded shell_command history is byte-identical.
      const [v1Context, v2Context] = await Promise.all([
        pair.v1.getContext(input),
        pair.v2.getContext(input),
      ]);
      const projectContext = KNOWN_DIFFS.getContext;
      expect(projectContext(v2Context)).toEqual(projectContext(v1Context));
      expect(v1Context.history).toHaveLength(4);
      await expect(
        pair.v1.runShellCommand({ sessionId: 'session_missing', command: 'true' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        pair.v2.runShellCommand({ sessionId: 'session_missing', command: 'true' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('prompt launches a turn and updates title/lastPrompt identically', async () => {
    const restoreEnv = scrubConfigEnv();
    // Model-less on purpose: parity covers the pre-provider surface — the
    // call returns without throwing and the metadata update (same shared
    // helpers on both engines) lands before the turn fails asynchronously.
    // The enqueue-semantics gaps (v1 drops a mid-turn prompt, v2 queues it;
    // v1 ignores disabledTools, v2 applies it) are pinned in the tracker.
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_prompt' });
      const input = { sessionId: 'session_parity_agent_prompt' } as const;
      await Promise.all([
        pair.v1.prompt({ ...input, input: [{ type: 'text', text: 'hello parity' }] }),
        pair.v2.prompt({ ...input, input: [{ type: 'text', text: 'hello parity' }] }),
      ]);
      const project = KNOWN_DIFFS.listSessions;
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      expect(normalize(project(v2List, pair.v2Home), 'id')).toEqual(
        normalize(project(v1List, pair.v1Home), 'id'),
      );
      expect(v1List[0]?.title).toBe('hello parity');
      expect(v1List[0]?.lastPrompt).toBe('hello parity');
      await expect(
        pair.v1.prompt({ sessionId: 'session_missing', input: [{ type: 'text', text: 'x' }] }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        pair.v2.prompt({ sessionId: 'session_missing', input: [{ type: 'text', text: 'x' }] }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      // Let the model-less turns finish failing before close.
      await settleTurns();
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('steer on an idle session: both engines launch a turn and update metadata', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_steer' });
      const input = { sessionId: 'session_parity_agent_steer' } as const;
      // v1 treats an idle steer like a prompt — it launches a fresh turn and
      // updates title/lastPrompt. v2's steer RPC enqueues first (which itself
      // launches the turn) and converges on the same end state: the launched
      // turn is returned instead of rejecting, and the metadata is updated.
      await pair.v1.steer({ ...input, input: [{ type: 'text', text: 'steer text' }] });
      await pair.v2.steer({ ...input, input: [{ type: 'text', text: 'steer text' }] });
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      expect(v1List[0]?.title).toBe('steer text');
      expect(v1List[0]?.lastPrompt).toBe('steer text');
      expect(v2List[0]?.title).toBe('steer text');
      expect(v2List[0]?.lastPrompt).toBe('steer text');
      await settleTurns();
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('activateSkill renders, launches, and rejects identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    // The skill must exist before either session is created (both engines
    // load their skill catalog at session start).
    await writeSkill(join(pair.workDir, '.kimi-code', 'skills', 'parity-skill'), 'parity-skill');
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_skill' });
      const input = { sessionId: 'session_parity_agent_skill' } as const;
      await Promise.all([
        pair.v1.activateSkill({ ...input, name: 'parity-skill', args: 'some args' }),
        pair.v2.activateSkill({ ...input, name: 'parity-skill', args: 'some args' }),
      ]);
      const project = KNOWN_DIFFS.listSessions;
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      expect(normalize(project(v2List, pair.v2Home), 'id')).toEqual(
        normalize(project(v1List, pair.v1Home), 'id'),
      );
      expect(v1List[0]?.lastPrompt).toBe('/parity-skill some args');
      // An unknown skill rejects synchronously with the same code and text.
      const rejection = 'Skill "missing-skill" was not found';
      await expect(
        pair.v1.activateSkill({ ...input, name: 'missing-skill' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SKILL_NOT_FOUND });
      await expect(pair.v1.activateSkill({ ...input, name: 'missing-skill' })).rejects.toThrowError(
        rejection,
      );
      await expect(
        pair.v2.activateSkill({ ...input, name: 'missing-skill' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SKILL_NOT_FOUND });
      await expect(pair.v2.activateSkill({ ...input, name: 'missing-skill' })).rejects.toThrowError(
        rejection,
      );
      await settleTurns();
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('activatePluginCommand activates and rejects identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    const sourceDir = await makeTempDir('kimi-sdk-parity-plugin-src-');
    await writeFixturePlugin(sourceDir);
    try {
      await pair.v1.installPlugin(sourceDir);
      await pair.v2.installPlugin(sourceDir);
      // The v1 session connects the plugin's enabled MCP servers at
      // creation; disable them first so the test stays offline (same rule
      // as the plugin batch; same-engine mutations stay sequential).
      await pair.v1.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-stdio', false);
      await pair.v1.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-http', false);
      await pair.v2.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-stdio', false);
      await pair.v2.setPluginMcpServerEnabled(FIXTURE_PLUGIN_ID, 'parity-http', false);
      // v1 resolves commands against the session's creation-time snapshot,
      // so the session must be created after the install; v2 uses the
      // app-global live view.
      await createOnBoth(pair, { id: 'session_parity_agent_plugincmd' });
      const input = { sessionId: 'session_parity_agent_plugincmd' } as const;
      // An unknown command rejects with the same code and text.
      const rejection = 'Plugin command "p:c" was not found';
      await expect(
        pair.v1.activatePluginCommand({ ...input, pluginId: 'p', commandName: 'c' }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(
        pair.v1.activatePluginCommand({ ...input, pluginId: 'p', commandName: 'c' }),
      ).rejects.toThrowError(rejection);
      await expect(
        pair.v2.activatePluginCommand({ ...input, pluginId: 'p', commandName: 'c' }),
      ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(
        pair.v2.activatePluginCommand({ ...input, pluginId: 'p', commandName: 'c' }),
      ).rejects.toThrowError(rejection);
      // The known command activates and updates title/lastPrompt identically.
      await Promise.all([
        pair.v1.activatePluginCommand({
          ...input,
          pluginId: FIXTURE_PLUGIN_ID,
          commandName: 'parity-command',
        }),
        pair.v2.activatePluginCommand({
          ...input,
          pluginId: FIXTURE_PLUGIN_ID,
          commandName: 'parity-command',
        }),
      ]);
      const project = KNOWN_DIFFS.listSessions;
      const [v1List, v2List] = await Promise.all([
        pair.v1.listSessions(),
        pair.v2.listSessions(),
      ]);
      expect(normalize(project(v2List, pair.v2Home), 'id')).toEqual(
        normalize(project(v1List, pair.v1Home), 'id'),
      );
      expect(v1List[0]?.lastPrompt).toBe('/parity-plugin:parity-command');
      await settleTurns();
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('generateAgentsMd rejects model-less with session.init_failed on both engines (pinned message gap)', async () => {
    const restoreEnv = scrubConfigEnv();
    // The success path spawns a real subagent LLM round (the /init brief),
    // so parity stops at the model-less rejection — registered as
    // provider-boundary-only in the migration tracker.
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_init' });
      const input = { sessionId: 'session_parity_agent_init' } as const;
      // Same code; the message differs by design (pinned): v1 wraps the
      // provider-resolution failure from the spawned init turn, v2 preflights
      // the missing model binding.
      await expect(pair.v1.generateAgentsMd(input)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_INIT_FAILED,
        message: expect.stringContaining('LLM not set'),
      });
      await expect(pair.v2.generateAgentsMd(input)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_INIT_FAILED,
        message: 'Main agent has no model bound',
      });
      await expect(pair.v1.generateAgentsMd({ sessionId: 'session_missing' })).rejects.toMatchObject(
        { code: ErrorCodes.SESSION_NOT_FOUND },
      );
      await expect(pair.v2.generateAgentsMd({ sessionId: 'session_missing' })).rejects.toMatchObject(
        { code: ErrorCodes.SESSION_NOT_FOUND },
      );
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('getSessionWarnings reports an oversized AGENTS.md identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_agent_warnings' });
      const input = { sessionId: 'session_parity_agent_warnings' } as const;
      const [v1Empty, v2Empty] = await Promise.all([
        pair.v1.getSessionWarnings(input),
        pair.v2.getSessionWarnings(input),
      ]);
      expect(v2Empty).toEqual(v1Empty);
      expect(v1Empty).toEqual([]);
      // Written after create on purpose: v1's cache holds no warning and
      // recomputes on demand; the v2 SDK recomputes through the engine's own
      // prepareSystemPromptContext — the mid-session growth surfaces on both.
      await writeFile(join(pair.workDir, 'AGENTS.md'), 'a'.repeat(40 * 1024), 'utf-8');
      const [v1Warnings, v2Warnings] = await Promise.all([
        pair.v1.getSessionWarnings(input),
        pair.v2.getSessionWarnings(input),
      ]);
      expect(v2Warnings).toEqual(v1Warnings);
      expect(v1Warnings).toHaveLength(1);
      expect(v1Warnings[0]).toMatchObject({ code: 'agents-md-oversized', severity: 'warning' });
      expect(v1Warnings[0]?.message).toContain('exceeds the recommended');
      await expect(pair.v1.getSessionWarnings({ sessionId: 'session_missing' })).rejects.toMatchObject(
        { code: ErrorCodes.SESSION_NOT_FOUND },
      );
      await expect(pair.v2.getSessionWarnings({ sessionId: 'session_missing' })).rejects.toMatchObject(
        { code: ErrorCodes.SESSION_NOT_FOUND },
      );
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('applyPersistedSecondaryModel validates, applies, and refreshes warnings identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair(SECONDARY_MODEL_CONFIG_TOML);
    try {
      await createOnBoth(pair, { id: 'session_parity_secondary_apply' });
      const input = { sessionId: 'session_parity_secondary_apply' } as const;
      const applyError = (client: SDKRpcClient | SDKRpcClientV2) =>
        client.applyPersistedSecondaryModel(input).then(
          () => undefined,
          (error: unknown) => error as Error,
        );

      // No recipe persisted yet: both reject with v1's persist-first error.
      const [v1NoRecipe, v2NoRecipe] = await Promise.all([
        applyError(pair.v1),
        applyError(pair.v2),
      ]);
      expect(v1NoRecipe).toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
      expect(v2NoRecipe).toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
      expect(v2NoRecipe?.message).toBe(v1NoRecipe?.message);

      // A dangling recipe: both reject, pointing at [secondary_model].
      await Promise.all([
        pair.v1.setConfig({ secondaryModel: { model: 'missing-model' } }),
        pair.v2.setConfig({ secondaryModel: { model: 'missing-model' } }),
      ]);
      const [v1Broken, v2Broken] = await Promise.all([
        applyError(pair.v1),
        applyError(pair.v2),
      ]);
      expect(v1Broken).toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
      expect(v2Broken).toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
      expect(v1Broken?.message).toContain('[secondary_model].model');
      expect(v2Broken?.message).toContain('[secondary_model].model');

      // A valid recipe: both apply cleanly. The warnings pull converges on
      // empty — v1's snapshot never held the broken recipe (its apply
      // validates before mutating), v2's live-config warning cache is
      // refreshed by the successful apply.
      await Promise.all([
        pair.v1.setConfig({ secondaryModel: { model: 'fixture-model' } }),
        pair.v2.setConfig({ secondaryModel: { model: 'fixture-model' } }),
      ]);
      await Promise.all([
        pair.v1.applyPersistedSecondaryModel(input),
        pair.v2.applyPersistedSecondaryModel(input),
      ]);
      const [v1Warnings, v2Warnings] = await Promise.all([
        pair.v1.getSessionWarnings(input),
        pair.v2.getSessionWarnings(input),
      ]);
      expect(v2Warnings).toEqual(v1Warnings);
      expect(v1Warnings).toEqual([]);

      await expect(
        pair.v1.applyPersistedSecondaryModel({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        pair.v2.applyPersistedSecondaryModel({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('getSessionWarnings flags a creation-time broken secondary recipe on both engines', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair(SECONDARY_MODEL_BROKEN_CONFIG_TOML);
    try {
      await createOnBoth(pair, { id: 'session_parity_secondary_broken' });
      const input = { sessionId: 'session_parity_secondary_broken' } as const;
      const [v1Warnings, v2Warnings] = await Promise.all([
        pair.v1.getSessionWarnings(input),
        pair.v2.getSessionWarnings(input),
      ]);
      // The message wording is engine-specific; the code + severity are the
      // shared contract.
      const codes = (warnings: readonly { code: string; severity: string }[]) =>
        warnings.map(({ code, severity }) => ({ code, severity }));
      expect(codes(v2Warnings)).toEqual(codes(v1Warnings));
      expect(codes(v1Warnings)).toEqual([
        { code: 'secondary-model-invalid', severity: 'warning' },
      ]);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// Goal / cron / background tasks / print policy parity
//
// Same driving rule as the earlier batches: `SDKRpcClient` / `SDKRpcClientV2`
// directly, isolated per-engine homes, one SHARED workDir, explicit session
// ids. The goal state machine and the cron list need no model at all; the
// background-task cases use the configured home (v1 only assembles its
// builtin Bash tool on a profiled agent) and detach a FOREGROUND shell
// command into a real background task through the SDK surface — no provider
// calls anywhere. The print-policy cases pin the
// `background.print_background_mode` matrix (exit / drain / steer, the
// legacy keep_alive_on_exit fallback, and the steer caps).
// ---------------------------------------------------------------------------

describe('v1↔v2 goal parity', () => {
  it('goal lifecycle matches: create / get / pause / resume / replace / cancel', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_goal' });
      const input = { sessionId: 'session_parity_goal' } as const;
      const [v1Created, v2Created] = await Promise.all([
        pair.v1.createGoal({ ...input, objective: 'Ship the parity goal.' }),
        pair.v2.createGoal({ ...input, objective: 'Ship the parity goal.' }),
      ]);
      const projectCreate = KNOWN_DIFFS.createGoal;
      expect(projectCreate(v2Created)).toEqual(projectCreate(v1Created));
      expect(v1Created).toMatchObject({ status: 'active', turnsUsed: 0, tokensUsed: 0 });
      expect(v1Created.goalId.length).toBeGreaterThan(0);
      expect(v2Created.goalId.length).toBeGreaterThan(0);
      // A second create without replace rejects identically.
      await expect(
        pair.v1.createGoal({ ...input, objective: 'Another goal.' }),
      ).rejects.toMatchObject({ code: ErrorCodes.GOAL_ALREADY_EXISTS });
      await expect(
        pair.v2.createGoal({ ...input, objective: 'Another goal.' }),
      ).rejects.toMatchObject({ code: ErrorCodes.GOAL_ALREADY_EXISTS });
      // Objective validation matches (same codes, same message text).
      await expect(
        pair.v1.createGoal({ ...input, objective: '   ', replace: true }),
      ).rejects.toMatchObject({ code: ErrorCodes.GOAL_OBJECTIVE_EMPTY });
      await expect(
        pair.v2.createGoal({ ...input, objective: '   ', replace: true }),
      ).rejects.toMatchObject({ code: ErrorCodes.GOAL_OBJECTIVE_EMPTY });
      await expect(
        pair.v1.createGoal({ ...input, objective: 'x'.repeat(4001), replace: true }),
      ).rejects.toMatchObject({ code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG });
      await expect(
        pair.v2.createGoal({ ...input, objective: 'x'.repeat(4001), replace: true }),
      ).rejects.toMatchObject({ code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG });
      const [v1Got, v2Got] = await Promise.all([pair.v1.getGoal(input), pair.v2.getGoal(input)]);
      const projectGet = KNOWN_DIFFS.getGoal;
      expect(projectGet(v2Got)).toEqual(projectGet(v1Got));
      expect(v1Got.goal).not.toBeNull();
      // Pause is a status transition and idempotent on both engines.
      const [v1Paused, v2Paused] = await Promise.all([
        pair.v1.pauseGoal(input),
        pair.v2.pauseGoal(input),
      ]);
      const projectPause = KNOWN_DIFFS.pauseGoal;
      expect(projectPause(v2Paused)).toEqual(projectPause(v1Paused));
      expect(v1Paused.status).toBe('paused');
      const [v1PausedAgain, v2PausedAgain] = await Promise.all([
        pair.v1.pauseGoal(input),
        pair.v2.pauseGoal(input),
      ]);
      expect(projectPause(v2PausedAgain)).toEqual(projectPause(v1PausedAgain));
      // Resume re-activates and clears the stop reason on both engines.
      const [v1Resumed, v2Resumed] = await Promise.all([
        pair.v1.resumeGoal(input),
        pair.v2.resumeGoal(input),
      ]);
      const projectResume = KNOWN_DIFFS.resumeGoal;
      expect(projectResume(v2Resumed)).toEqual(projectResume(v1Resumed));
      expect(v1Resumed.status).toBe('active');
      expect(v1Resumed.terminalReason).toBeUndefined();
      expect(v2Resumed.terminalReason).toBeUndefined();
      // Replace swaps in a fresh goal on both engines.
      const [v1Replaced, v2Replaced] = await Promise.all([
        pair.v1.createGoal({ ...input, objective: 'Replacement goal.', replace: true }),
        pair.v2.createGoal({ ...input, objective: 'Replacement goal.', replace: true }),
      ]);
      expect(projectCreate(v2Replaced)).toEqual(projectCreate(v1Replaced));
      expect(v1Replaced).toMatchObject({ status: 'active', objective: 'Replacement goal.' });
      // Cancel returns the removed snapshot; afterwards the goal is gone.
      const [v1Cancelled, v2Cancelled] = await Promise.all([
        pair.v1.cancelGoal(input),
        pair.v2.cancelGoal(input),
      ]);
      const projectCancel = KNOWN_DIFFS.cancelGoal;
      expect(projectCancel(v2Cancelled)).toEqual(projectCancel(v1Cancelled));
      expect(v1Cancelled.status).toBe('active');
      const [v1Empty, v2Empty] = await Promise.all([pair.v1.getGoal(input), pair.v2.getGoal(input)]);
      expect(projectGet(v2Empty)).toEqual(projectGet(v1Empty));
      expect(v1Empty.goal).toBeNull();
      // Lifecycle calls without a goal reject identically.
      await expect(pair.v1.cancelGoal(input)).rejects.toMatchObject({
        code: ErrorCodes.GOAL_NOT_FOUND,
      });
      await expect(pair.v2.cancelGoal(input)).rejects.toMatchObject({
        code: ErrorCodes.GOAL_NOT_FOUND,
      });
      await expect(pair.v1.pauseGoal(input)).rejects.toMatchObject({
        code: ErrorCodes.GOAL_NOT_FOUND,
      });
      await expect(pair.v2.pauseGoal(input)).rejects.toMatchObject({
        code: ErrorCodes.GOAL_NOT_FOUND,
      });
      await expect(pair.v1.resumeGoal(input)).rejects.toMatchObject({
        code: ErrorCodes.GOAL_NOT_FOUND,
      });
      await expect(pair.v2.resumeGoal(input)).rejects.toMatchObject({
        code: ErrorCodes.GOAL_NOT_FOUND,
      });
      // Goal calls require a live session on both engines.
      await expect(
        pair.v1.createGoal({ sessionId: 'session_missing', objective: 'x' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        pair.v2.createGoal({ sessionId: 'session_missing', objective: 'x' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('an active goal survives close+resume with the same pause demotion on both engines', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_goal_resume' });
      const input = { sessionId: 'session_parity_goal_resume' } as const;
      await Promise.all([
        pair.v1.createGoal({ ...input, objective: 'Persisted parity goal.' }),
        pair.v2.createGoal({ ...input, objective: 'Persisted parity goal.' }),
      ]);
      await Promise.all([
        pair.v1.closeSession({ sessionId: input.sessionId }),
        pair.v2.closeSession({ sessionId: input.sessionId }),
      ]);
      await Promise.all([
        pair.v1.resumeSession({ id: input.sessionId }),
        pair.v2.resumeSession({ id: input.sessionId }),
      ]);
      // An active goal cannot still be running after a restart: both engines
      // demote it to paused with the same reason on replay.
      const [v1Got, v2Got] = await Promise.all([pair.v1.getGoal(input), pair.v2.getGoal(input)]);
      const projectGet = KNOWN_DIFFS.getGoal;
      expect(projectGet(v2Got)).toEqual(projectGet(v1Got));
      expect(v1Got.goal).toMatchObject({
        status: 'paused',
        objective: 'Persisted parity goal.',
        terminalReason: 'Paused after agent resume',
      });
      // The demoted goal resumes identically.
      const [v1Resumed, v2Resumed] = await Promise.all([
        pair.v1.resumeGoal(input),
        pair.v2.resumeGoal(input),
      ]);
      const projectResume = KNOWN_DIFFS.resumeGoal;
      expect(projectResume(v2Resumed)).toEqual(projectResume(v1Resumed));
      expect(v1Resumed.status).toBe('active');
      expect(v1Resumed.terminalReason).toBeUndefined();
      expect(v2Resumed.terminalReason).toBeUndefined();
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('getCronTasks returns the same empty list on a fresh session', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_cron' });
      const input = { sessionId: 'session_parity_cron' } as const;
      const [v1Cron, v2Cron] = await Promise.all([
        pair.v1.getCronTasks(input),
        pair.v2.getCronTasks(input),
      ]);
      expect(v2Cron).toEqual(v1Cron);
      expect(v1Cron).toEqual({ tasks: [] });
      await expect(pair.v1.getCronTasks({ sessionId: 'session_missing' })).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
      await expect(pair.v2.getCronTasks({ sessionId: 'session_missing' })).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
      });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });
});

// --- Background-task helpers ------------------------------------------------

interface ShellRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly backgrounded?: boolean;
}

async function waitForBackgroundTask(
  rpc: SDKRpcClientBase,
  sessionId: string,
  match: (task: BackgroundTaskInfo) => boolean,
  timeoutMs = 10_000,
): Promise<BackgroundTaskInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = (await rpc.listBackgroundTasks({ sessionId })).find(match);
    if (task !== undefined) return task;
    if (Date.now() >= deadline) throw new Error('timed out waiting for a background task');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let shellCommandSeq = 0;

/**
 * Start a foreground shell command that stays running and detach it into a
 * real background task — the only model-free way to create one through the
 * SDK surface (the Bash tool registers foreground commands as tasks, and the
 * detach releases the tool-call waiter, resolving the run as backgrounded).
 */
async function startDetachedBackgroundTask(
  rpc: SDKRpcClientBase,
  sessionId: string,
  command: string,
): Promise<{ readonly taskId: string; readonly run: Promise<ShellRunResult> }> {
  shellCommandSeq += 1;
  const run = rpc.runShellCommand({
    sessionId,
    command,
    commandId: `cmd-bg-${String(shellCommandSeq)}`,
  });
  const task = await waitForBackgroundTask(
    rpc,
    sessionId,
    (candidate) => candidate.status === 'running',
  );
  await rpc.detachBackgroundTask({ sessionId, taskId: task.taskId });
  return { taskId: task.taskId, run };
}

async function stopAndSettle(rpc: SDKRpcClientBase, sessionId: string, taskId: string): Promise<void> {
  await rpc.stopBackgroundTask({ sessionId, taskId });
  // v1 fire-and-forgets the stop; poll both engines for the terminal state.
  await waitForBackgroundTask(
    rpc,
    sessionId,
    (candidate) => candidate.taskId === taskId && candidate.status !== 'running',
  );
}

describe('v1↔v2 background task parity', () => {
  it('task lifecycle matches: list / detach / output / stop', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_bgtask' });
      const input = { sessionId: 'session_parity_bgtask' } as const;
      // Empty list and unknown-id behaviors match.
      const [v1Empty, v2Empty] = await Promise.all([
        pair.v1.listBackgroundTasks(input),
        pair.v2.listBackgroundTasks(input),
      ]);
      expect(v2Empty).toEqual(v1Empty);
      expect(v1Empty).toEqual([]);
      await expect(
        pair.v1.getBackgroundTaskOutput({ ...input, taskId: 'bash-deadbeef' }),
      ).resolves.toBe('');
      await expect(
        pair.v2.getBackgroundTaskOutput({ ...input, taskId: 'bash-deadbeef' }),
      ).resolves.toBe('');
      await expect(
        pair.v1.detachBackgroundTask({ ...input, taskId: 'bash-deadbeef' }),
      ).resolves.toBeUndefined();
      await expect(
        pair.v2.detachBackgroundTask({ ...input, taskId: 'bash-deadbeef' }),
      ).resolves.toBeUndefined();
      await expect(
        pair.v1.stopBackgroundTask({ ...input, taskId: 'bash-deadbeef', reason: 'noop' }),
      ).resolves.toBeUndefined();
      await expect(
        pair.v2.stopBackgroundTask({ ...input, taskId: 'bash-deadbeef', reason: 'noop' }),
      ).resolves.toBeUndefined();
      // Start a foreground command on both engines; it registers as a
      // running (non-detached) task with the same info.
      const v1Run = pair.v1.runShellCommand({
        ...input,
        command: 'echo bg-out; sleep 30',
        commandId: 'cmd-bg-detach',
      });
      const v2Run = pair.v2.runShellCommand({
        ...input,
        command: 'echo bg-out; sleep 30',
        commandId: 'cmd-bg-detach',
      });
      const [v1Running, v2Running] = await Promise.all([
        waitForBackgroundTask(pair.v1, input.sessionId, (task) => task.status === 'running'),
        waitForBackgroundTask(pair.v2, input.sessionId, (task) => task.status === 'running'),
      ]);
      const projectList = KNOWN_DIFFS.listBackgroundTasks;
      expect(projectList([v2Running])).toEqual(projectList([v1Running]));
      expect(v1Running).toMatchObject({
        kind: 'process',
        command: 'echo bg-out; sleep 30',
        status: 'running',
        detached: false,
      });
      // The pinned timeoutMs gap only exists AFTER a detach; pre-detach both
      // report the foreground deadline (the 120s shell foreground timeout).
      expect(v1Running.timeoutMs).toBe(120_000);
      expect(v2Running.timeoutMs).toBe(120_000);
      expect(v1Running.taskId.startsWith('bash-')).toBe(true);
      expect(v2Running.taskId.startsWith('bash-')).toBe(true);
      // Detach releases the foreground waiter on both engines; the run
      // resolves backgrounded with the task metadata payload.
      const [v1Detached, v2Detached] = await Promise.all([
        pair.v1.detachBackgroundTask({ ...input, taskId: v1Running.taskId }),
        pair.v2.detachBackgroundTask({ ...input, taskId: v2Running.taskId }),
      ]);
      const projectDetach = KNOWN_DIFFS.detachBackgroundTask;
      expect(projectDetach(v2Detached)).toEqual(projectDetach(v1Detached));
      expect(v1Detached?.detached).toBe(true);
      const [v1RunResult, v2RunResult] = await Promise.all([v1Run, v2Run]);
      expect(v1RunResult.backgrounded).toBe(true);
      expect(v2RunResult.backgrounded).toBe(true);
      // Captured output (and the tail slice) reads back identically.
      const [v1Output, v2Output] = await Promise.all([
        pair.v1.getBackgroundTaskOutput({ ...input, taskId: v1Running.taskId }),
        pair.v2.getBackgroundTaskOutput({ ...input, taskId: v2Running.taskId }),
      ]);
      expect(v2Output).toEqual(v1Output);
      expect(v1Output).toBe('bg-out\n');
      const [v1Tail, v2Tail] = await Promise.all([
        pair.v1.getBackgroundTaskOutput({ ...input, taskId: v1Running.taskId, tail: 4 }),
        pair.v2.getBackgroundTaskOutput({ ...input, taskId: v2Running.taskId, tail: 4 }),
      ]);
      expect(v2Tail).toEqual(v1Tail);
      expect(v1Tail).toBe('out\n');
      // Stop with an explicit reason settles to killed with the reason
      // recorded (trimmed) on both engines.
      await Promise.all([
        pair.v1.stopBackgroundTask({ ...input, taskId: v1Running.taskId, reason: 'parity stop' }),
        pair.v2.stopBackgroundTask({ ...input, taskId: v2Running.taskId, reason: 'parity stop' }),
      ]);
      const [v1Killed, v2Killed] = await Promise.all([
        waitForBackgroundTask(
          pair.v1,
          input.sessionId,
          (task) => task.taskId === v1Running.taskId && task.status !== 'running',
        ),
        waitForBackgroundTask(
          pair.v2,
          input.sessionId,
          (task) => task.taskId === v2Running.taskId && task.status !== 'running',
        ),
      ]);
      expect(projectList([v2Killed])).toEqual(projectList([v1Killed]));
      expect(v1Killed).toMatchObject({ status: 'killed', stopReason: 'parity stop' });
      // Active-only filtering drops the terminal task on both engines.
      const [v1Active, v2Active] = await Promise.all([
        pair.v1.listBackgroundTasks({ ...input, activeOnly: true }),
        pair.v2.listBackgroundTasks({ ...input, activeOnly: true }),
      ]);
      expect(v2Active).toEqual(v1Active);
      expect(v1Active).toEqual([]);
      // Stopping an already-terminal task is a no-op on both engines.
      await expect(
        pair.v1.stopBackgroundTask({ ...input, taskId: v1Running.taskId }),
      ).resolves.toBeUndefined();
      await expect(
        pair.v2.stopBackgroundTask({ ...input, taskId: v2Running.taskId }),
      ).resolves.toBeUndefined();
      // Background-task calls require a live session on both engines.
      await expect(
        pair.v1.listBackgroundTasks({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        pair.v2.listBackgroundTasks({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });
});

// --- Print-policy parity ------------------------------------------------------

/** Fixture with a print background policy section layered on the agent config. */
function printConfig(backgroundSection: string): string {
  return `${AGENT_CONFIG_TOML}\n[background]\n${backgroundSection}\n`;
}

describe('v1↔v2 print policy parity', () => {
  it('steer mode (the default) keeps the run alive while tasks are pending', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_print_steer' });
      const input = { sessionId: 'session_parity_print_steer' } as const;
      // Quiescent: finish immediately.
      const [v1Idle, v2Idle] = await Promise.all([
        pair.v1.handlePrintMainTurnCompleted(input),
        pair.v2.handlePrintMainTurnCompleted(input),
      ]);
      expect(v2Idle).toEqual(v1Idle);
      expect(v1Idle).toBe('finish');
      // A pending background task: continue. waitForBackgroundTasksOnPrint is
      // a no-op outside drain mode — it resolves with the task still running.
      const v1Task = await startDetachedBackgroundTask(pair.v1, input.sessionId, 'sleep 30');
      const v2Task = await startDetachedBackgroundTask(pair.v2, input.sessionId, 'sleep 30');
      await Promise.all([v1Task.run, v2Task.run]);
      const [v1Busy, v2Busy] = await Promise.all([
        pair.v1.handlePrintMainTurnCompleted(input),
        pair.v2.handlePrintMainTurnCompleted(input),
      ]);
      expect(v2Busy).toEqual(v1Busy);
      expect(v1Busy).toBe('continue');
      await Promise.all([
        pair.v1.waitForBackgroundTasksOnPrint(input),
        pair.v2.waitForBackgroundTasksOnPrint(input),
      ]);
      const [v1StillRunning, v2StillRunning] = await Promise.all([
        pair.v1.listBackgroundTasks({ ...input, activeOnly: true }),
        pair.v2.listBackgroundTasks({ ...input, activeOnly: true }),
      ]);
      expect(v1StillRunning).toHaveLength(1);
      expect(v2StillRunning).toHaveLength(1);
      // Once the task is gone the steer policy finishes.
      await Promise.all([
        stopAndSettle(pair.v1, input.sessionId, v1Task.taskId),
        stopAndSettle(pair.v2, input.sessionId, v2Task.taskId),
      ]);
      const [v1Done, v2Done] = await Promise.all([
        pair.v1.handlePrintMainTurnCompleted(input),
        pair.v2.handlePrintMainTurnCompleted(input),
      ]);
      expect(v2Done).toEqual(v1Done);
      expect(v1Done).toBe('finish');
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('drain mode waits for pending tasks and then finishes', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair(printConfig('print_background_mode = "drain"'));
    try {
      await createOnBoth(pair, { id: 'session_parity_print_drain' });
      const input = { sessionId: 'session_parity_print_drain' } as const;
      // A short-lived detached task: the drain blocks until it completes.
      const v1Task = await startDetachedBackgroundTask(
        pair.v1,
        input.sessionId,
        'sleep 0.3 && echo drain-done',
      );
      const v2Task = await startDetachedBackgroundTask(
        pair.v2,
        input.sessionId,
        'sleep 0.3 && echo drain-done',
      );
      await Promise.all([v1Task.run, v2Task.run]);
      await Promise.all([
        pair.v1.waitForBackgroundTasksOnPrint(input),
        pair.v2.waitForBackgroundTasksOnPrint(input),
      ]);
      // By the time the drain returns the task is terminal on both engines,
      // with its terminal notification suppressed (same drain side effect).
      const projectList = KNOWN_DIFFS.listBackgroundTasks;
      const [v1Tasks, v2Tasks] = await Promise.all([
        pair.v1.listBackgroundTasks(input),
        pair.v2.listBackgroundTasks(input),
      ]);
      expect(projectList(v2Tasks)).toEqual(projectList(v1Tasks));
      expect(v1Tasks).toHaveLength(1);
      expect(v1Tasks[0]).toMatchObject({
        status: 'completed',
        exitCode: 0,
        terminalNotificationSuppressed: true,
      });
      const [v1Output, v2Output] = await Promise.all([
        pair.v1.getBackgroundTaskOutput({ ...input, taskId: v1Task.taskId }),
        pair.v2.getBackgroundTaskOutput({ ...input, taskId: v2Task.taskId }),
      ]);
      expect(v2Output).toEqual(v1Output);
      expect(v1Output).toBe('drain-done\n');
      // With nothing left pending the policy finishes.
      const [v1Done, v2Done] = await Promise.all([
        pair.v1.handlePrintMainTurnCompleted(input),
        pair.v2.handlePrintMainTurnCompleted(input),
      ]);
      expect(v2Done).toEqual(v1Done);
      expect(v1Done).toBe('finish');
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('keep_alive_on_exit = true keeps the legacy drain mapping', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair(printConfig('keep_alive_on_exit = true'));
    try {
      await createOnBoth(pair, { id: 'session_parity_print_legacy' });
      const input = { sessionId: 'session_parity_print_legacy' } as const;
      const v1Task = await startDetachedBackgroundTask(pair.v1, input.sessionId, 'sleep 0.3');
      const v2Task = await startDetachedBackgroundTask(pair.v2, input.sessionId, 'sleep 0.3');
      await Promise.all([v1Task.run, v2Task.run]);
      // Steer would answer 'continue' here; the legacy mapping drains first
      // and answers 'finish' with the task already terminal.
      const [v1Done, v2Done] = await Promise.all([
        pair.v1.handlePrintMainTurnCompleted(input),
        pair.v2.handlePrintMainTurnCompleted(input),
      ]);
      expect(v2Done).toEqual(v1Done);
      expect(v1Done).toBe('finish');
      const [v1Active, v2Active] = await Promise.all([
        pair.v1.listBackgroundTasks({ ...input, activeOnly: true }),
        pair.v2.listBackgroundTasks({ ...input, activeOnly: true }),
      ]);
      expect(v2Active).toEqual(v1Active);
      expect(v1Active).toEqual([]);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('exit mode finishes immediately with tasks still running', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair(printConfig('print_background_mode = "exit"'));
    try {
      await createOnBoth(pair, { id: 'session_parity_print_exit' });
      const input = { sessionId: 'session_parity_print_exit' } as const;
      const v1Task = await startDetachedBackgroundTask(pair.v1, input.sessionId, 'sleep 30');
      const v2Task = await startDetachedBackgroundTask(pair.v2, input.sessionId, 'sleep 30');
      await Promise.all([v1Task.run, v2Task.run]);
      const [v1Done, v2Done] = await Promise.all([
        pair.v1.handlePrintMainTurnCompleted(input),
        pair.v2.handlePrintMainTurnCompleted(input),
      ]);
      expect(v2Done).toEqual(v1Done);
      expect(v1Done).toBe('finish');
      // waitForBackgroundTasksOnPrint is a no-op too; the task is untouched.
      await Promise.all([
        pair.v1.waitForBackgroundTasksOnPrint(input),
        pair.v2.waitForBackgroundTasksOnPrint(input),
      ]);
      const [v1Active, v2Active] = await Promise.all([
        pair.v1.listBackgroundTasks({ ...input, activeOnly: true }),
        pair.v2.listBackgroundTasks({ ...input, activeOnly: true }),
      ]);
      expect(v1Active).toHaveLength(1);
      expect(v2Active).toHaveLength(1);
      await Promise.all([
        stopAndSettle(pair.v1, input.sessionId, v1Task.taskId),
        stopAndSettle(pair.v2, input.sessionId, v2Task.taskId),
      ]);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('steer mode finishes at the max-turns cap and the wall-clock ceiling', async () => {
    const restoreEnv = scrubConfigEnv();
    const maxTurnsPair = await makeAgentParityPair(printConfig('print_max_turns = 1'));
    const ceilingPair = await makeAgentParityPair(printConfig('print_wait_ceiling_s = 1'));
    try {
      // print_max_turns = 1: the first completed turn may continue, the
      // second crosses the cap.
      await createOnBoth(maxTurnsPair, { id: 'session_parity_print_maxturns' });
      const maxTurnsInput = { sessionId: 'session_parity_print_maxturns' } as const;
      const v1MaxTask = await startDetachedBackgroundTask(
        maxTurnsPair.v1,
        maxTurnsInput.sessionId,
        'sleep 30',
      );
      const v2MaxTask = await startDetachedBackgroundTask(
        maxTurnsPair.v2,
        maxTurnsInput.sessionId,
        'sleep 30',
      );
      await Promise.all([v1MaxTask.run, v2MaxTask.run]);
      const [v1First, v2First] = await Promise.all([
        maxTurnsPair.v1.handlePrintMainTurnCompleted(maxTurnsInput),
        maxTurnsPair.v2.handlePrintMainTurnCompleted(maxTurnsInput),
      ]);
      expect(v2First).toEqual(v1First);
      expect(v1First).toBe('continue');
      const [v1Second, v2Second] = await Promise.all([
        maxTurnsPair.v1.handlePrintMainTurnCompleted(maxTurnsInput),
        maxTurnsPair.v2.handlePrintMainTurnCompleted(maxTurnsInput),
      ]);
      expect(v2Second).toEqual(v1Second);
      expect(v1Second).toBe('finish');
      await Promise.all([
        stopAndSettle(maxTurnsPair.v1, maxTurnsInput.sessionId, v1MaxTask.taskId),
        stopAndSettle(maxTurnsPair.v2, maxTurnsInput.sessionId, v2MaxTask.taskId),
      ]);
      // print_wait_ceiling_s = 1: the deadline armed by the first call is
      // crossed by the second.
      await createOnBoth(ceilingPair, { id: 'session_parity_print_ceiling' });
      const ceilingInput = { sessionId: 'session_parity_print_ceiling' } as const;
      const v1CeilingTask = await startDetachedBackgroundTask(
        ceilingPair.v1,
        ceilingInput.sessionId,
        'sleep 30',
      );
      const v2CeilingTask = await startDetachedBackgroundTask(
        ceilingPair.v2,
        ceilingInput.sessionId,
        'sleep 30',
      );
      await Promise.all([v1CeilingTask.run, v2CeilingTask.run]);
      const [v1Before, v2Before] = await Promise.all([
        ceilingPair.v1.handlePrintMainTurnCompleted(ceilingInput),
        ceilingPair.v2.handlePrintMainTurnCompleted(ceilingInput),
      ]);
      expect(v2Before).toEqual(v1Before);
      expect(v1Before).toBe('continue');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const [v1After, v2After] = await Promise.all([
        ceilingPair.v1.handlePrintMainTurnCompleted(ceilingInput),
        ceilingPair.v2.handlePrintMainTurnCompleted(ceilingInput),
      ]);
      expect(v2After).toEqual(v1After);
      expect(v1After).toBe('finish');
      await Promise.all([
        stopAndSettle(ceilingPair.v1, ceilingInput.sessionId, v1CeilingTask.taskId),
        stopAndSettle(ceilingPair.v2, ceilingInput.sessionId, v2CeilingTask.taskId),
      ]);
      // Print-policy calls require a live session on both engines.
      await expect(
        maxTurnsPair.v1.handlePrintMainTurnCompleted({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        maxTurnsPair.v2.handlePrintMainTurnCompleted({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        maxTurnsPair.v1.waitForBackgroundTasksOnPrint({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        maxTurnsPair.v2.waitForBackgroundTasksOnPrint({ sessionId: 'session_missing' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    } finally {
      await closeSessionPair(maxTurnsPair);
      await closeSessionPair(ceilingPair);
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// MCP parity. The global group drives isolated homes with the same mcp.json
// fixture written into each (a write through one engine must not be observed
// by the other mid-test); fixtures never declare reachable remote servers —
// the OAuth success path needs a real authorization server (network) and is
// registered as a provider boundary in the migration tracker, so only the
// pre-network guards and the flowId bookkeeping are compared. The stdio
// fixtures spawn local commands only.
// ---------------------------------------------------------------------------

const MCP_STDIO_FIXTURE = join(
  import.meta.dirname,
  '../../agent-core/test/mcp/fixtures/mock-stdio-server.mjs',
);

interface GlobalMcpParityPair {
  readonly v1: SDKRpcClient;
  readonly v2: SDKRpcClientV2;
  readonly v1Home: HomePair;
  readonly v2Home: HomePair;
  readonly v1HomeDir: string;
  readonly v2HomeDir: string;
}

async function writeMcpJson(homeDir: string, value: unknown): Promise<void> {
  await writeFile(join(homeDir, 'mcp.json'), JSON.stringify(value), 'utf-8');
}

async function makeGlobalMcpParityPair(mcpJson?: unknown): Promise<GlobalMcpParityPair> {
  const v1HomeDir = await makeTempDir('kimi-sdk-parity-v1-home-');
  const v2HomeDir = await makeTempDir('kimi-sdk-parity-v2-home-');
  if (mcpJson !== undefined) {
    await writeMcpJson(v1HomeDir, mcpJson);
    await writeMcpJson(v2HomeDir, mcpJson);
  }
  return {
    v1: new SDKRpcClient({ homeDir: v1HomeDir, identity: TEST_IDENTITY }),
    v2: new SDKRpcClientV2({ homeDir: v2HomeDir, identity: TEST_IDENTITY }),
    v1Home: { raw: v1HomeDir, real: await realpath(v1HomeDir) },
    v2Home: { raw: v2HomeDir, real: await realpath(v2HomeDir) },
    v1HomeDir,
    v2HomeDir,
  };
}

async function closeGlobalMcpPair(pair: GlobalMcpParityPair): Promise<void> {
  await pair.v1.close();
  await pair.v2.close();
}

/** The rejection of a call, or a test failure when the call resolves. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  expect.unreachable('expected the call to reject');
}

/**
 * Both engines must reject with the same code and the same message (home
 * prefixes scrubbed — the file-store errors embed the mcp.json path).
 */
async function expectSameMcpRejection(
  pair: GlobalMcpParityPair,
  v1Call: (client: SDKRpcClient) => Promise<unknown>,
  v2Call: (client: SDKRpcClientV2) => Promise<unknown>,
): Promise<void> {
  const [v1Error, v2Error] = await Promise.all([
    captureRejection(v1Call(pair.v1)),
    captureRejection(v2Call(pair.v2)),
  ]);
  const payload = (error: unknown): unknown => {
    const err = error as { code?: unknown; message?: unknown };
    return { code: err.code ?? null, message: String(err.message ?? error) };
  };
  expect(scrubHomePrefixes(payload(v2Error), pair.v2Home)).toEqual(
    scrubHomePrefixes(payload(v1Error), pair.v1Home),
  );
}

describe('v1↔v2 global MCP parity', () => {
  it('classifies global MCP authorization identically from persisted credentials', async () => {
    const statusServer = await startMcpAuthStatusServer();
    const authorizedUrl = 'https://authorized.example.test/mcp';
    const pair = await makeGlobalMcpParityPair({
      mcpServers: {
        stdio: { command: 'local-command' },
        plain: { transport: 'http', url: statusServer.plainUrl },
        detected: { transport: 'http', url: statusServer.oauthUrl },
        sse: { transport: 'sse', url: statusServer.oauthUrl },
        'sse-oauth': { transport: 'sse', url: statusServer.oauthUrl, auth: 'oauth' },
        bearer: {
          transport: 'http',
          url: 'https://bearer.example.test/mcp',
          bearerTokenEnvVar: 'EXAMPLE_MCP_TOKEN',
        },
        'oauth-required': {
          transport: 'http',
          url: 'https://required.example.test/mcp',
          auth: 'oauth',
        },
        'oauth-authorized': {
          transport: 'http',
          url: authorizedUrl,
          auth: 'oauth',
        },
      },
    });
    for (const homeDir of [pair.v1HomeDir, pair.v2HomeDir]) {
      const externalOAuth = new McpOAuthService({ kimiHomeDir: homeDir });
      externalOAuth
        .getProvider('oauth-authorized', authorizedUrl)
        .saveTokens({ access_token: 'test-access-token', token_type: 'Bearer' });
      externalOAuth
        .getProvider('sse', statusServer.oauthUrl)
        .saveTokens({ access_token: 'stale-sse-token', token_type: 'Bearer' });
    }

    try {
      const [v1Statuses, v2Statuses] = await Promise.all([
        pair.v1.listGlobalMcpServerAuthStatuses(),
        pair.v2.listGlobalMcpServerAuthStatuses(),
      ]);
      expect(v2Statuses).toEqual(v1Statuses);
      expect(v1Statuses).toEqual([
        { name: 'stdio', authStatus: 'not-applicable' },
        { name: 'plain', authStatus: 'not-applicable' },
        { name: 'detected', authStatus: 'oauth-required' },
        { name: 'sse', authStatus: 'not-applicable' },
        { name: 'sse-oauth', authStatus: 'oauth-required' },
        { name: 'bearer', authStatus: 'bearer-token' },
        { name: 'oauth-required', authStatus: 'oauth-required' },
        { name: 'oauth-authorized', authStatus: 'oauth-authorized' },
      ]);
    } finally {
      await closeGlobalMcpPair(pair);
      await statusServer.close();
    }
  }, 15_000);

  it('CRUD round-trips identically and writes byte-identical mcp.json files', async () => {
    const pair = await makeGlobalMcpParityPair({
      custom: { keep: true },
      mcpServers: {
        'existing-stdio': { command: 'existing-command' },
        'existing-http': {
          transport: 'http',
          url: 'https://example.test/mcp',
          auth: 'oauth',
        },
      },
    });
    try {
      const [v1Initial, v2Initial] = await Promise.all([
        pair.v1.listGlobalMcpServers(),
        pair.v2.listGlobalMcpServers(),
      ]);
      expect(normalize(v2Initial, 'name')).toEqual(normalize(v1Initial, 'name'));
      // The transport-less stdio entry parses with `transport: 'stdio'`
      // injected; the `auth: 'oauth'` marker survives the round-trip.
      expect(v1Initial).toEqual([
        {
          name: 'existing-stdio',
          transport: 'stdio',
          command: 'existing-command',
        },
        {
          name: 'existing-http',
          transport: 'http',
          url: 'https://example.test/mcp',
          auth: 'oauth',
        },
      ]);

      const added: McpServerConfig = {
        name: 'added',
        transport: 'stdio',
        command: 'added-command',
        args: ['--flag'],
        enabledTools: ['echo'],
      };
      const [v1Added, v2Added] = await Promise.all([
        pair.v1.addGlobalMcpServer(added),
        pair.v2.addGlobalMcpServer(added),
      ]);
      expect(normalize(v2Added, 'name')).toEqual(normalize(v1Added, 'name'));

      const updated: McpServerConfig = {
        name: 'existing-http',
        transport: 'sse',
        url: 'https://example.test/sse',
        headers: { 'x-fixture': 'yes' },
      };
      const [v1Updated, v2Updated] = await Promise.all([
        pair.v1.updateGlobalMcpServer(updated),
        pair.v2.updateGlobalMcpServer(updated),
      ]);
      expect(normalize(v2Updated, 'name')).toEqual(normalize(v1Updated, 'name'));

      const [v1Removed, v2Removed] = await Promise.all([
        pair.v1.removeGlobalMcpServer('existing-stdio'),
        pair.v2.removeGlobalMcpServer('existing-stdio'),
      ]);
      expect(normalize(v2Removed, 'name')).toEqual(normalize(v1Removed, 'name'));
      expect(v1Removed.map((server) => server.name)).toEqual(['existing-http', 'added']);

      // The persisted files are byte-identical across the engines (same
      // formatting, unrelated top-level content preserved).
      const [v1File, v2File] = await Promise.all([
        readFile(join(pair.v1HomeDir, 'mcp.json'), 'utf-8'),
        readFile(join(pair.v2HomeDir, 'mcp.json'), 'utf-8'),
      ]);
      expect(v2File).toBe(v1File);
    } finally {
      await closeGlobalMcpPair(pair);
    }
  });

  it('CRUD rejections match on both engines', async () => {
    const pair = await makeGlobalMcpParityPair({
      mcpServers: { existing: { command: 'existing-command' } },
    });
    try {
      await expectSameMcpRejection(
        pair,
        (client) =>
          client.addGlobalMcpServer({
            name: 'existing',
            transport: 'stdio',
            command: 'duplicate',
          }),
        (client) =>
          client.addGlobalMcpServer({
            name: 'existing',
            transport: 'stdio',
            command: 'duplicate',
          }),
      );
      await expectSameMcpRejection(
        pair,
        (client) =>
          client.updateGlobalMcpServer({ name: 'missing', transport: 'stdio', command: 'x' }),
        (client) =>
          client.updateGlobalMcpServer({ name: 'missing', transport: 'stdio', command: 'x' }),
      );
      await expectSameMcpRejection(
        pair,
        (client) => client.addGlobalMcpServer({ name: '   ', transport: 'stdio', command: 'x' }),
        (client) => client.addGlobalMcpServer({ name: '   ', transport: 'stdio', command: 'x' }),
      );
      // Schema-invalid entry (neither command nor url): same schema on both
      // sides, so the config.invalid message matches too.
      await expectSameMcpRejection(
        pair,
        (client) =>
          client.addGlobalMcpServer({ name: 'invalid' } as never),
        (client) =>
          client.addGlobalMcpServer({ name: 'invalid' } as never),
      );
      // Removing an unknown name is NOT an error on either engine — the
      // unchanged list comes back.
      const [v1Removed, v2Removed] = await Promise.all([
        pair.v1.removeGlobalMcpServer('missing'),
        pair.v2.removeGlobalMcpServer('missing'),
      ]);
      expect(normalize(v2Removed, 'name')).toEqual(normalize(v1Removed, 'name'));
      expect(v1Removed).toHaveLength(1);
    } finally {
      await closeGlobalMcpPair(pair);
    }
  });

  it('a malformed mcp.json rejects every read with the same config.invalid', async () => {
    const pair = await makeGlobalMcpParityPair();
    await writeFile(join(pair.v1HomeDir, 'mcp.json'), '{ not valid json', 'utf-8');
    await writeFile(join(pair.v2HomeDir, 'mcp.json'), '{ not valid json', 'utf-8');
    try {
      await expectSameMcpRejection(
        pair,
        (client) => client.listGlobalMcpServers(),
        (client) => client.listGlobalMcpServers(),
      );
    } finally {
      await closeGlobalMcpPair(pair);
    }
  });

  it('OAuth guards and flow bookkeeping match without contacting a server', async () => {
    const pair = await makeGlobalMcpParityPair({
      mcpServers: {
        stdio: { command: 'local-command' },
        'bearer-remote': {
          transport: 'http',
          url: 'https://example.test/mcp',
          bearerTokenEnvVar: 'FIXTURE_MCP_TOKEN',
        },
        'headers-remote': {
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: { authorization: 'Bearer static' },
        },
        'plain-remote': { transport: 'http', url: 'https://example.test/mcp' },
      },
    });
    try {
      // begin: unknown server / non-remote / static token / static headers
      // all reject before any network I/O.
      await expectSameMcpRejection(
        pair,
        (client) => client.beginGlobalMcpServerAuth('missing'),
        (client) => client.beginGlobalMcpServerAuth('missing'),
      );
      await expectSameMcpRejection(
        pair,
        (client) => client.beginGlobalMcpServerAuth('stdio'),
        (client) => client.beginGlobalMcpServerAuth('stdio'),
      );
      await expectSameMcpRejection(
        pair,
        (client) => client.beginGlobalMcpServerAuth('bearer-remote'),
        (client) => client.beginGlobalMcpServerAuth('bearer-remote'),
      );
      await expectSameMcpRejection(
        pair,
        (client) => client.beginGlobalMcpServerAuth('headers-remote'),
        (client) => client.beginGlobalMcpServerAuth('headers-remote'),
      );
      // reset: unknown / non-remote reject; a plain remote invalidates
      // (no stored credentials — a no-op on both engines).
      await expectSameMcpRejection(
        pair,
        (client) => client.resetGlobalMcpServerAuth('missing'),
        (client) => client.resetGlobalMcpServerAuth('missing'),
      );
      await expectSameMcpRejection(
        pair,
        (client) => client.resetGlobalMcpServerAuth('stdio'),
        (client) => client.resetGlobalMcpServerAuth('stdio'),
      );
      await Promise.all([
        pair.v1.resetGlobalMcpServerAuth('plain-remote'),
        pair.v2.resetGlobalMcpServerAuth('plain-remote'),
      ]);
      // Flow bookkeeping: an unknown flowId rejects on complete and is a
      // silent no-op on cancel, on both engines.
      await expectSameMcpRejection(
        pair,
        (client) => client.completeGlobalMcpServerAuth({ flowId: 'flow_missing' }),
        (client) => client.completeGlobalMcpServerAuth({ flowId: 'flow_missing' }),
      );
      await Promise.all([
        pair.v1.cancelGlobalMcpServerAuth('flow_missing'),
        pair.v2.cancelGlobalMcpServerAuth('flow_missing'),
      ]);
    } finally {
      await closeGlobalMcpPair(pair);
    }
  });

  it('testGlobalMcpServer reports the same probe results', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeGlobalMcpParityPair({
      mcpServers: {
        working: { command: process.execPath, args: [MCP_STDIO_FIXTURE] },
        missing: { command: '/definitely/not/a/real/mcp-executable' },
      },
    });
    try {
      await expectSameMcpRejection(
        pair,
        (client) => client.testGlobalMcpServer('unknown-server'),
        (client) => client.testGlobalMcpServer('unknown-server'),
      );
      const [v1Working, v2Working] = await Promise.all([
        pair.v1.testGlobalMcpServer('working'),
        pair.v2.testGlobalMcpServer('working'),
      ]);
      expect(v2Working).toEqual(v1Working);
      expect(v1Working.success).toBe(true);
      expect(v1Working.output).toContain('Available tools: 3');
      const [v1Missing, v2Missing] = await Promise.all([
        pair.v1.testGlobalMcpServer('missing'),
        pair.v2.testGlobalMcpServer('missing'),
      ]);
      expect(v2Missing).toEqual(v1Missing);
      expect(v1Missing.success).toBe(false);
      expect(v1Missing.output).toMatch(/ENOENT|not found|spawn/i);
    } finally {
      await closeGlobalMcpPair(pair);
      restoreEnv();
    }
  }, 20_000);
});

type McpServerList = Awaited<ReturnType<SDKRpcClientBase['listMcpServers']>>;

/**
 * List MCP servers on both engines once the initial connect has settled.
 * v1 connects in the background after create resolves while v2 awaits the
 * initial connect inside create, so an immediate list can catch either side
 * still pending under load; poll until no server reports a transient status.
 */
async function listMcpServersWhenSettled(
  pair: SessionParityPair,
  input: { readonly sessionId: string },
  timeoutMs = 10_000,
): Promise<readonly [McpServerList, McpServerList]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lists = await Promise.all([
      pair.v1.listMcpServers(input),
      pair.v2.listMcpServers(input),
    ] as const);
    const settled = lists.every((servers) =>
      servers.every((server) => server.status !== 'pending'),
    );
    if (settled || Date.now() >= deadline) return lists;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('v1↔v2 session MCP parity', () => {
  /** working (connects, 3 tools) + broken (fails fast) + off (disabled). */
  const SESSION_MCP_FIXTURE = {
    mcpServers: {
      working: { command: process.execPath, args: [MCP_STDIO_FIXTURE] },
      broken: { command: '/definitely/not/a/real/mcp-executable' },
      off: { command: process.execPath, args: [MCP_STDIO_FIXTURE], enabled: false },
    },
  };

  async function makeSessionMcpPair(mcpJson?: unknown): Promise<SessionParityPair> {
    const pair = await makeSessionParityPair();
    if (mcpJson !== undefined) {
      await writeMcpJson(pair.v1Home.raw, mcpJson);
      await writeMcpJson(pair.v2Home.raw, mcpJson);
    }
    return pair;
  }

  it('listMcpServers reports the same entries after the initial connect', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionMcpPair(SESSION_MCP_FIXTURE);
    try {
      await createOnBoth(pair, { id: 'session_parity_mcp_list' });
      const input = { sessionId: 'session_parity_mcp_list' } as const;
      const [v1Servers, v2Servers] = await listMcpServersWhenSettled(pair, input);
      expect(normalize(v2Servers, 'name')).toEqual(normalize(v1Servers, 'name'));
      const byName = new Map(v1Servers.map((server) => [server.name, server]));
      expect(byName.get('working')).toMatchObject({
        transport: 'stdio',
        status: 'connected',
        toolCount: 3,
      });
      expect(byName.get('broken')).toMatchObject({ status: 'failed', toolCount: 0 });
      expect(byName.get('off')).toMatchObject({ status: 'disabled', toolCount: 0 });
      // An empty-config session lists nothing on either engine.
      const emptyPair = await makeSessionMcpPair();
      try {
        await createOnBoth(emptyPair, { id: 'session_parity_mcp_empty' });
        const emptyInput = { sessionId: 'session_parity_mcp_empty' } as const;
        const [v1Empty, v2Empty] = await Promise.all([
          emptyPair.v1.listMcpServers(emptyInput),
          emptyPair.v2.listMcpServers(emptyInput),
        ]);
        expect(v2Empty).toEqual(v1Empty);
        expect(v1Empty).toEqual([]);
        // Session-level reads require a live session on both engines.
        await expect(
          emptyPair.v1.listMcpServers({ sessionId: 'session_missing' }),
        ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
        await expect(
          emptyPair.v2.listMcpServers({ sessionId: 'session_missing' }),
        ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      } finally {
        await closeSessionPair(emptyPair);
      }
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  }, 20_000);

  it('getMcpStartupMetrics agrees, exactly 0 without servers', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionMcpPair(SESSION_MCP_FIXTURE);
    try {
      await createOnBoth(pair, { id: 'session_parity_mcp_metrics' });
      const input = { sessionId: 'session_parity_mcp_metrics' } as const;
      const [v1Metrics, v2Metrics] = await Promise.all([
        pair.v1.getMcpStartupMetrics(input),
        pair.v2.getMcpStartupMetrics(input),
      ]);
      const project = KNOWN_DIFFS.getMcpStartupMetrics;
      expect(project(v2Metrics)).toEqual(project(v1Metrics));
      expect(v1Metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(v2Metrics.durationMs).toBeGreaterThanOrEqual(0);

      const emptyPair = await makeSessionMcpPair();
      try {
        await createOnBoth(emptyPair, { id: 'session_parity_mcp_metrics_empty' });
        const emptyInput = { sessionId: 'session_parity_mcp_metrics_empty' } as const;
        const [v1Empty, v2Empty] = await Promise.all([
          emptyPair.v1.getMcpStartupMetrics(emptyInput),
          emptyPair.v2.getMcpStartupMetrics(emptyInput),
        ]);
        expect(v2Empty).toEqual(v1Empty);
        expect(v1Empty).toEqual({ durationMs: 0 });
        await expect(
          emptyPair.v1.getMcpStartupMetrics({ sessionId: 'session_missing' }),
        ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
        await expect(
          emptyPair.v2.getMcpStartupMetrics({ sessionId: 'session_missing' }),
        ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      } finally {
        await closeSessionPair(emptyPair);
      }
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  }, 20_000);

  it('reconnectMcpServer rejects and reconnects identically', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionMcpPair(SESSION_MCP_FIXTURE);
    try {
      await createOnBoth(pair, { id: 'session_parity_mcp_reconnect' });
      const input = { sessionId: 'session_parity_mcp_reconnect' } as const;
      const [v1Unknown, v2Unknown] = await Promise.all([
        captureRejection(pair.v1.reconnectMcpServer({ ...input, name: 'missing' })),
        captureRejection(pair.v2.reconnectMcpServer({ ...input, name: 'missing' })),
      ]);
      expect(v2Unknown).toMatchObject({ code: 'mcp.server_not_found' });
      expect((v1Unknown as Error).message).toBe((v2Unknown as Error).message);
      const [v1Disabled, v2Disabled] = await Promise.all([
        captureRejection(pair.v1.reconnectMcpServer({ ...input, name: 'off' })),
        captureRejection(pair.v2.reconnectMcpServer({ ...input, name: 'off' })),
      ]);
      expect(v2Disabled).toMatchObject({ code: 'mcp.server_disabled' });
      expect((v1Disabled as Error).message).toBe((v2Disabled as Error).message);
      // Reconnecting the working server re-settles as connected with its
      // tools rediscovered, on both engines.
      await Promise.all([
        pair.v1.reconnectMcpServer({ ...input, name: 'working' }),
        pair.v2.reconnectMcpServer({ ...input, name: 'working' }),
      ]);
      const [v1Servers, v2Servers] = await Promise.all([
        pair.v1.listMcpServers(input),
        pair.v2.listMcpServers(input),
      ]);
      expect(normalize(v2Servers, 'name')).toEqual(normalize(v1Servers, 'name'));
      await expect(
        pair.v1.reconnectMcpServer({ sessionId: 'session_missing', name: 'working' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
      await expect(
        pair.v2.reconnectMcpServer({ sessionId: 'session_missing', name: 'working' }),
      ).rejects.toMatchObject({ code: ErrorCodes.SESSION_NOT_FOUND });
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Event & approval/question parity
//
// The v2 client forwards the engine's per-agent event buses into the base
// class's event listeners (translated back to the v1 `Event` shape) and
// bridges the interaction kernel's pending approvals / questions to the
// registered handlers. The v1 side of the approval/question cases drives the
// base class's `requestApproval` / `requestQuestion` directly — the same
// entry point the v1 engine's push RPC lands on — because a real turn's
// approval needs a model; the v2 side parks a real pending interaction in the
// live session's kernel through the engine accessor. No provider calls.
// ---------------------------------------------------------------------------

/** Project a captured event stream down to the comparable per-type shape. */
function projectEventStream(events: readonly Event[], sessionId: string): unknown[] {
  return events
    .filter((event) => event.sessionId === sessionId)
    .flatMap((event) => {
      switch (event.type) {
        // Pinned: emission timing differs by design — v1 emits on its eager
        // agent lifecycle points (mostly before a test's listeners attach),
        // v2 on the lazy main-agent bind (after); the v2 payload is also a
        // narrower slice (no phase/permission/contextUsage). The type maps
        // 1:1 and is forwarded; full content parity is out of scope.
        case 'agent.status.updated':
          return [];
        case 'shell.output':
          return {
            type: event.type,
            commandId: event.commandId,
            kind: event.update.kind,
            text: event.update.text,
          };
        case 'shell.started':
          // taskId embeds a per-engine random suffix; only presence compares.
          return { type: event.type, commandId: event.commandId, hasTaskId: true };
        case 'shell.completed':
          return {
            type: event.type,
            commandId: event.commandId,
            isError: event.isError,
            hasTaskId: event.taskId !== undefined,
          };
        case 'turn.started':
          return { type: event.type, originKind: event.origin.kind };
        case 'turn.ended':
          return { type: event.type, reason: event.reason, errorCode: event.error?.code };
        case 'session.meta.updated':
          return { type: event.type, title: event.title, lastPrompt: event.patch?.['lastPrompt'] };
        case 'error':
          return { type: event.type, code: event.code, message: event.message };
        default:
          return { type: event.type };
      }
    });
}

/**
 * The `shell.*` slice of a captured stream without `shell.completed`: the v1
 * engine has no emission site for it anywhere (grep agent-core), while v2
 * fires it when a foreground command settles — a union-legal event the v2
 * stream is simply richer by. The tests assert its v2 presence explicitly
 * and compare the started/output sequence v1 actually produces.
 */
function projectShellStream(events: readonly Event[], sessionId: string): unknown[] {
  return projectEventStream(events, sessionId).filter(
    (projected) => (projected as { type: string }).type !== 'shell.completed',
  );
}

describe('v1↔v2 event & interaction parity', () => {
  it('forwards the same shell.* event sequence for a `!` command', async () => {
    const restoreEnv = scrubConfigEnv();
    // The configured home keeps v1's builtin tools assembled (the model-less
    // v1 session answers "Bash tool is not available." — pinned in batch 4b).
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_events_shell' });
      const input = { sessionId: 'session_parity_events_shell' } as const;
      const v1Events: Event[] = [];
      const v2Events: Event[] = [];
      pair.v1.onEvent((event) => v1Events.push(event));
      pair.v2.onEvent((event) => v2Events.push(event));
      await Promise.all([
        pair.v1.runShellCommand({ ...input, command: 'echo out; echo err >&2', commandId: 'cmd-ev' }),
        pair.v2.runShellCommand({ ...input, command: 'echo out; echo err >&2', commandId: 'cmd-ev' }),
      ]);
      const v1Projected = projectShellStream(v1Events, input.sessionId);
      const v2Projected = projectShellStream(v2Events, input.sessionId);
      expect(v2Projected).toEqual(v1Projected);
      // The compared surface: started, the two stream chunks (v1 never emits
      // shell.completed — see projectShellStream).
      expect(v1Projected).toEqual([
        { type: 'shell.started', commandId: 'cmd-ev', hasTaskId: true },
        { type: 'shell.output', commandId: 'cmd-ev', kind: 'stdout', text: 'out\n' },
        { type: 'shell.output', commandId: 'cmd-ev', kind: 'stderr', text: 'err\n' },
      ]);
      // Pinned richer-v2 behavior: the settle event v1 never fires IS
      // forwarded on the v2 stream (union-legal, asserted explicitly).
      const v2Completed = projectEventStream(v2Events, input.sessionId).filter(
        (projected) => (projected as { type: string }).type === 'shell.completed',
      );
      expect(v2Completed).toEqual([
        { type: 'shell.completed', commandId: 'cmd-ev', isError: false, hasTaskId: true },
      ]);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('keeps exactly one event subscription per session across a reload', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeAgentParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_events_rewire' });
      const input = { sessionId: 'session_parity_events_rewire' } as const;
      const v1Events: Event[] = [];
      const v2Events: Event[] = [];
      pair.v1.onEvent((event) => v1Events.push(event));
      pair.v2.onEvent((event) => v2Events.push(event));
      await Promise.all([
        pair.v1.runShellCommand({ ...input, command: 'echo one', commandId: 'cmd-one' }),
        pair.v2.runShellCommand({ ...input, command: 'echo one', commandId: 'cmd-one' }),
      ]);
      await Promise.all([pair.v1.reloadSession(input), pair.v2.reloadSession(input)]);
      await Promise.all([
        pair.v1.runShellCommand({ ...input, command: 'echo two', commandId: 'cmd-two' }),
        pair.v2.runShellCommand({ ...input, command: 'echo two', commandId: 'cmd-two' }),
      ]);
      const v1Projected = projectShellStream(v1Events, input.sessionId);
      const v2Projected = projectShellStream(v2Events, input.sessionId);
      expect(v2Projected).toEqual(v1Projected);
      // A wiring leaked across the reload would double the second command's
      // events; exactly one started per command proves the close-path
      // teardown.
      expect(
        v2Projected.filter((projected) => (projected as { type: string }).type === 'shell.started'),
      ).toHaveLength(2);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('forwards the same event sequence for a model-less prompt failure', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_events_prompt' });
      const input = { sessionId: 'session_parity_events_prompt' } as const;
      const v1Events: Event[] = [];
      const v2Events: Event[] = [];
      pair.v1.onEvent((event) => v1Events.push(event));
      pair.v2.onEvent((event) => v2Events.push(event));
      await Promise.all([
        pair.v1.prompt({ ...input, input: [{ type: 'text', text: 'hello events' }] }),
        pair.v2.prompt({ ...input, input: [{ type: 'text', text: 'hello events' }] }),
      ]);
      await settleTurns();
      // Two pinned engine-internal differences in the failure path, both
      // projected out at the call site: v2 interrupts the in-flight step
      // before ending the turn (`turn.step.interrupted`) where v1's turn
      // fails before the first step exists, and the trailing `error` event
      // carries the same code but different message wording (v1: the
      // login-guided 'LLM not set' text; v2: 'Model not set' — the same
      // pinned wording family as setModel / generateAgentsMd).
      const projectFailure = (events: readonly Event[]): unknown[] =>
        projectEventStream(events, input.sessionId).flatMap((projected) => {
          const entry = projected as { type: string; code?: string };
          if (entry.type === 'turn.step.interrupted') return [];
          if (entry.type === 'error') return { type: entry.type, code: entry.code };
          return entry;
        });
      const v1Projected = projectFailure(v1Events);
      const v2Projected = projectFailure(v2Events);
      expect(v2Projected).toEqual(v1Projected);
      // Sanity: the prompt metadata update and the failed turn both
      // surfaced on the v1 side, so the comparison is non-vacuous.
      expect(v1Projected.map((event) => (event as { type: string }).type)).toEqual(
        expect.arrayContaining(['session.meta.updated', 'turn.started', 'turn.ended']),
      );
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('bridges a pending approval to the session handler with v1 semantics', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_events_approval' });
      const sessionId = 'session_parity_events_approval';
      const v2Session = getLiveSessionById(pair.v2.engineAccessor, sessionId);
      expect(v2Session).toBeDefined();
      const v2Approvals = v2Session!.accessor.get(ISessionApprovalService);
      const requestInput = {
        turnId: 1,
        toolCallId: 'tc-parity-approval',
        toolName: 'Bash',
        action: 'Run command',
        display: { kind: 'generic', summary: 'Run command', detail: { command: 'ls' } } as const,
      };

      // Handler approves: the engine-side request resolves with the handler's
      // response on both engines, and the handler observes the same request.
      const observed: { v1?: unknown; v2?: unknown } = {};
      const handler =
        (sink: 'v1' | 'v2') =>
        (request: ApprovalRequest): ApprovalResponse => {
          observed[sink] = request;
          return { decision: 'approved', scope: 'session' };
        };
      pair.v1.setApprovalHandler(sessionId, handler('v1'));
      pair.v2.setApprovalHandler(sessionId, handler('v2'));
      const [v1Response, v2Response] = await Promise.all([
        pair.v1.requestApproval({ ...requestInput, sessionId, agentId: 'main' }),
        v2Approvals.request({ ...requestInput, sessionId, agentId: 'main' }),
      ]);
      expect(v2Response).toEqual(v1Response);
      expect(v1Response).toEqual({ decision: 'approved', scope: 'session' });
      expect(observed.v2).toEqual(observed.v1);
      expect(v2Approvals.listPending()).toEqual([]);

      // No handler: both cancel with the same decision and feedback.
      pair.v1.setApprovalHandler(sessionId, undefined);
      pair.v2.setApprovalHandler(sessionId, undefined);
      const [v1Unanswered, v2Unanswered] = await Promise.all([
        pair.v1.requestApproval({ ...requestInput, toolCallId: 'tc-2', sessionId, agentId: 'main' }),
        v2Approvals.request({ ...requestInput, toolCallId: 'tc-2', sessionId, agentId: 'main' }),
      ]);
      expect(v2Unanswered).toEqual(v1Unanswered);
      expect(v1Unanswered).toEqual({
        decision: 'cancelled',
        feedback: 'No approval handler registered.',
      });

      // Handler throws: both cancel with the same feedback and emit the same
      // error event into the session's event stream.
      const v1Events: Event[] = [];
      const v2Events: Event[] = [];
      pair.v1.onEvent((event) => v1Events.push(event));
      pair.v2.onEvent((event) => v2Events.push(event));
      const failing = (): never => {
        throw new Error('handler boom');
      };
      pair.v1.setApprovalHandler(sessionId, failing);
      pair.v2.setApprovalHandler(sessionId, failing);
      const [v1Failed, v2Failed] = await Promise.all([
        pair.v1.requestApproval({ ...requestInput, toolCallId: 'tc-3', sessionId, agentId: 'main' }),
        v2Approvals.request({ ...requestInput, toolCallId: 'tc-3', sessionId, agentId: 'main' }),
      ]);
      expect(v2Failed).toEqual(v1Failed);
      expect(v1Failed).toEqual({ decision: 'cancelled', feedback: 'Approval handler failed.' });
      const v1Errors = projectEventStream(v1Events, sessionId);
      const v2Errors = projectEventStream(v2Events, sessionId);
      expect(v2Errors).toEqual(v1Errors);
      expect(v1Errors).toEqual([
        { type: 'error', code: 'session.approval_handler_error', message: 'handler boom' },
      ]);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });

  it('bridges a pending question to the session handler with v1 semantics', async () => {
    const restoreEnv = scrubConfigEnv();
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_events_question' });
      const sessionId = 'session_parity_events_question';
      const v2Session = getLiveSessionById(pair.v2.engineAccessor, sessionId);
      expect(v2Session).toBeDefined();
      const v2Questions = v2Session!.accessor.get(ISessionQuestionService);
      const requestInput = {
        turnId: 1,
        toolCallId: 'tc-parity-question',
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [{ label: 'a', description: 'first' }, { label: 'b' }],
            multiSelect: false,
          },
        ],
      };

      // Handler answers: the engine-side request resolves with the handler's
      // answers on both engines, and the handler observes the same request.
      const observed: { v1?: unknown; v2?: unknown } = {};
      const handler =
        (sink: 'v1' | 'v2') =>
        (request: QuestionRequest): QuestionResult => {
          observed[sink] = request;
          return { answers: { 'Pick one': 'a' }, method: 'enter' };
        };
      pair.v1.setQuestionHandler(sessionId, handler('v1'));
      pair.v2.setQuestionHandler(sessionId, handler('v2'));
      const [v1Result, v2Result] = await Promise.all([
        pair.v1.requestQuestion({ ...requestInput, sessionId, agentId: 'main' }),
        v2Questions.request({ ...requestInput }, { agentId: 'main' }),
      ]);
      expect(v2Result).toEqual(v1Result);
      expect(v1Result).toEqual({ answers: { 'Pick one': 'a' }, method: 'enter' });
      expect(observed.v2).toEqual(observed.v1);
      expect(v2Questions.listPending()).toEqual([]);

      // No handler: both answer null (the dismissed outcome on both engines).
      pair.v1.setQuestionHandler(sessionId, undefined);
      pair.v2.setQuestionHandler(sessionId, undefined);
      const [v1Dismissed, v2Dismissed] = await Promise.all([
        pair.v1.requestQuestion({ ...requestInput, toolCallId: 'tc-2', sessionId, agentId: 'main' }),
        v2Questions.request({ ...requestInput, toolCallId: 'tc-2' }, { agentId: 'main' }),
      ]);
      expect(v2Dismissed).toEqual(v1Dismissed);
      expect(v1Dismissed).toBeNull();

      // Handler throws: both answer null and emit the same error event.
      const v1Events: Event[] = [];
      const v2Events: Event[] = [];
      pair.v1.onEvent((event) => v1Events.push(event));
      pair.v2.onEvent((event) => v2Events.push(event));
      const failing = (): never => {
        throw new Error('question boom');
      };
      pair.v1.setQuestionHandler(sessionId, failing);
      pair.v2.setQuestionHandler(sessionId, failing);
      const [v1Failed, v2Failed] = await Promise.all([
        pair.v1.requestQuestion({ ...requestInput, toolCallId: 'tc-3', sessionId, agentId: 'main' }),
        v2Questions.request({ ...requestInput, toolCallId: 'tc-3' }, { agentId: 'main' }),
      ]);
      expect(v2Failed).toEqual(v1Failed);
      expect(v1Failed).toBeNull();
      const v1Errors = projectEventStream(v1Events, sessionId);
      const v2Errors = projectEventStream(v2Events, sessionId);
      expect(v2Errors).toEqual(v1Errors);
      expect(v1Errors).toEqual([
        { type: 'error', code: 'session.question_handler_error', message: 'question boom' },
      ]);
    } finally {
      await closeSessionPair(pair);
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// Residual surface parity (exportSession / startBtw / swarm mode / listSkills)
//
// The last migrated methods, driven through `SDKRpcClient` / `SDKRpcClientV2`
// directly like the other session batches. No provider calls: export reads
// persisted state, btw/swarm are context-only, and the `swarm()` case uses the
// model-less prompt failure path (its turn start/end is what drives the
// task-trigger auto-exit on both engines).
// ---------------------------------------------------------------------------

/** Poll a condition until it holds or the budget runs out (engine-async settle). */
async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('v1↔v2 residual surface parity', () => {
  it('exportSession packages the same entry list and manifest on both engines', async () => {
    const pair = await makeSessionParityPair();
    const outDir = await makeTempDir('kimi-sdk-parity-export-');
    try {
      await createOnBoth(pair, { id: 'session_parity_export' });
      const sessionId = 'session_parity_export';
      // Give both sessions the same persisted wire activity to package.
      await Promise.all([
        pair.v1.importContext({ sessionId, content: 'export parity context', source: 'parity' }),
        pair.v2.importContext({ sessionId, content: 'export parity context', source: 'parity' }),
      ]);
      const input = {
        id: sessionId,
        version: '1.2.3',
        installSource: 'parity-install',
        shellEnv: { term: 'xterm', shell: '/bin/zsh' },
      } as const;
      const [v1Result, v2Result] = await Promise.all([
        pair.v1.exportSession({ ...input, outputPath: join(outDir, 'v1.zip') }),
        pair.v2.exportSession({ ...input, outputPath: join(outDir, 'v2.zip') }),
      ]);
      // The zip entry list IS part of the parity surface: both engines lay
      // the session directory out as state.json + agents/main/wire.jsonl.
      expect(normalize(v2Result.entries, '')).toEqual(normalize(v1Result.entries, ''));
      expect(normalize(v1Result.entries, '')).toEqual([
        'agents/main/wire.jsonl',
        'manifest.json',
        'state.json',
      ]);
      const project = KNOWN_DIFFS.exportSession;
      expect(project(v2Result, pair.v2Home)).toEqual(project(v1Result, pair.v1Home));
      // Explicit assertions for the projected fields (see KNOWN_DIFFS):
      // per-run stamps differ, each engine reports its own wire version, and
      // only v2's scanner finds the per-agent wire (v1 scans a stale root
      // path and reports no activity — the pinned v1-side defect).
      expect(typeof v1Result.manifest.exportedAt).toBe('string');
      expect(typeof v2Result.manifest.exportedAt).toBe('string');
      expect(v1Result.manifest.wireProtocolVersion).not.toBe(
        v2Result.manifest.wireProtocolVersion,
      );
      expect(v1Result.manifest.sessionFirstActivity).toBeUndefined();
      expect(typeof v2Result.manifest.sessionFirstActivity).toBe('string');
      // The archives actually landed on disk, non-empty.
      const v1Zip = await readFile(v1Result.zipPath);
      const v2Zip = await readFile(v2Result.zipPath);
      expect(v1Zip.byteLength).toBeGreaterThan(0);
      expect(v2Zip.byteLength).toBeGreaterThan(0);
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('exportSession rejects an unknown session with SESSION_NOT_FOUND on both engines', async () => {
    const pair = await makeSessionParityPair();
    try {
      const input = { id: 'session_missing', version: '1.2.3' } as const;
      // Same code; the message wording differs (v1 store vs v2 index).
      await expect(pair.v1.exportSession(input)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: 'Session "session_missing" was not found',
      });
      await expect(pair.v2.exportSession(input)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: 'Session "session_missing" does not exist',
      });
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('exportSession validates the host version only on v2 (pinned gap)', async () => {
    const pair = await makeSessionParityPair();
    const outDir = await makeTempDir('kimi-sdk-parity-export-');
    try {
      await createOnBoth(pair, { id: 'session_parity_export_version' });
      const input = { id: 'session_parity_export_version', version: '   ' } as const;
      // v1 records the blank version unchecked; v2 rejects it
      // (`session.export_missing_version`, a v2-only error code).
      await expect(
        pair.v1.exportSession({ ...input, outputPath: join(outDir, 'blank-version.zip') }),
      ).resolves.toMatchObject({
        manifest: { kimiCodeVersion: '   ' },
      });
      await expect(pair.v2.exportSession(input)).rejects.toMatchObject({
        code: 'session.export_missing_version',
      });
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('startBtw forks a side-question child with the parent context on both engines', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_btw' });
      const sessionId = 'session_parity_btw';
      await Promise.all([
        pair.v1.importContext({ sessionId, content: 'btw parity context', source: 'parity' }),
        pair.v2.importContext({ sessionId, content: 'btw parity context', source: 'parity' }),
      ]);
      const [v1ChildId, v2ChildId] = await Promise.all([
        pair.v1.startBtw({ sessionId }),
        pair.v2.startBtw({ sessionId }),
      ]);
      // The return is the forked child's agent id — random per engine, so
      // only its shape compares; the child's CONTEXT compares in full below.
      expect(typeof v1ChildId).toBe('string');
      expect(v1ChildId.length).toBeGreaterThan(0);
      expect(typeof v2ChildId).toBe('string');
      expect(v2ChildId.length).toBeGreaterThan(0);
      const [v1Context, v2Context] = await Promise.all([
        pair.v1.withInteractiveAgent(v1ChildId, () => pair.v1.getContext({ sessionId })),
        pair.v2.withInteractiveAgent(v2ChildId, () => pair.v2.getContext({ sessionId })),
      ]);
      // Inheritance gap, pinned: v1's btw child inherits through the
      // model-facing `project()`, which strips every message's `origin`,
      // while v2's fork appends the canonical messages verbatim (origin
      // kept). The message CONTENT is identical on both — compare with the
      // origins projected away.
      const stripOrigins = (context: { readonly history: readonly unknown[] }): unknown =>
        JSON.parse(
          JSON.stringify(context.history, (key, value: unknown) =>
            key === 'origin' ? undefined : value,
          ),
        );
      expect(stripOrigins(v2Context)).toEqual(stripOrigins(v1Context));
      // Non-vacuous: the inherited import plus the side-question reminder
      // (byte-identical template on both engines).
      const v1History = v1Context.history;
      expect(v1History.length).toBeGreaterThanOrEqual(2);
      const reminder = v1History.at(-1);
      expect(JSON.stringify(reminder)).toContain('side-channel conversation');
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('setSwarmMode toggles swarm mode with the same reminder lifecycle on both engines', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_swarm' });
      const input = { sessionId: 'session_parity_swarm' } as const;
      const statusOnBoth = () =>
        Promise.all([pair.v1.getStatus(input), pair.v2.getStatus(input)]);
      const historyOnBoth = () =>
        Promise.all([pair.v1.getContext(input), pair.v2.getContext(input)]);

      // Enter with the manual trigger: active on both, and the (byte-identical)
      // enter reminder lands in the context on both.
      await Promise.all([
        pair.v1.setSwarmMode({ ...input, enabled: true, trigger: 'manual' }),
        pair.v2.setSwarmMode({ ...input, enabled: true, trigger: 'manual' }),
      ]);
      const [v1Active, v2Active] = await statusOnBoth();
      expect(v1Active.swarmMode).toBe(true);
      expect(v2Active.swarmMode).toBe(true);
      const project = KNOWN_DIFFS.getContext;
      const [v1Entered, v2Entered] = await historyOnBoth();
      expect(project(v2Entered)).toEqual(project(v1Entered));
      expect(v1Entered.history).toHaveLength(1);
      expect(JSON.stringify(v1Entered.history[0])).toContain('<system-reminder>');

      // Enter is idempotent on both: still one reminder, still active.
      await Promise.all([
        pair.v1.setSwarmMode({ ...input, enabled: true, trigger: 'manual' }),
        pair.v2.setSwarmMode({ ...input, enabled: true, trigger: 'manual' }),
      ]);
      const [v1Twice, v2Twice] = await historyOnBoth();
      expect(v1Twice.history).toHaveLength(1);
      expect(v2Twice.history).toHaveLength(1);

      // Exit pops the reminder (it is the last message) on both.
      await Promise.all([
        pair.v1.setSwarmMode({ ...input, enabled: false }),
        pair.v2.setSwarmMode({ ...input, enabled: false }),
      ]);
      const [v1Inactive, v2Inactive] = await statusOnBoth();
      expect(v1Inactive.swarmMode).toBe(false);
      expect(v2Inactive.swarmMode).toBe(false);
      const [v1Exited, v2Exited] = await historyOnBoth();
      expect(project(v2Exited)).toEqual(project(v1Exited));
      expect(v1Exited.history).toHaveLength(0);

      // Exit is idempotent too: a second exit is a silent no-op on both.
      await Promise.all([
        pair.v1.setSwarmMode({ ...input, enabled: false }),
        pair.v2.setSwarmMode({ ...input, enabled: false }),
      ]);
      const [v1Idle, v2Idle] = await historyOnBoth();
      expect(v1Idle.history).toHaveLength(0);
      expect(v2Idle.history).toHaveLength(0);

      // The `tool` trigger injects no reminder on either engine.
      await Promise.all([
        pair.v1.setSwarmMode({ ...input, enabled: true, trigger: 'tool' }),
        pair.v2.setSwarmMode({ ...input, enabled: true, trigger: 'tool' }),
      ]);
      const [v1Tool, v2Tool] = await statusOnBoth();
      expect(v1Tool.swarmMode).toBe(true);
      expect(v2Tool.swarmMode).toBe(true);
      const [v1ToolHistory, v2ToolHistory] = await historyOnBoth();
      expect(v1ToolHistory.history).toHaveLength(0);
      expect(v2ToolHistory.history).toHaveLength(0);
      await Promise.all([
        pair.v1.setSwarmMode({ ...input, enabled: false }),
        pair.v2.setSwarmMode({ ...input, enabled: false }),
      ]);
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('swarm() enters task-triggered swarm mode, prompts, and auto-exits after the turn', async () => {
    const pair = await makeSessionParityPair();
    try {
      await createOnBoth(pair, { id: 'session_parity_swarm_prompt' });
      const input = { sessionId: 'session_parity_swarm_prompt' } as const;
      // The model-less prompt fails asynchronously on both engines; the turn
      // still starts and ends, which is what drives the task-trigger
      // auto-exit. `swarm()` itself resolves on both (v1's prompt RPC
      // returns after launch; v2's after enqueue).
      await Promise.all([
        pair.v1.swarm({ ...input, input: [{ type: 'text', text: 'parity swarm prompt' }] }),
        pair.v2.swarm({ ...input, input: [{ type: 'text', text: 'parity swarm prompt' }] }),
      ]);
      const settled = await waitForCondition(async () => {
        const [v1Status, v2Status] = await Promise.all([
          pair.v1.getStatus(input),
          pair.v2.getStatus(input),
        ]);
        return v1Status.swarmMode === false && v2Status.swarmMode === false;
      });
      expect(settled).toBe(true);
      await settleTurns();
    } finally {
      await closeSessionPair(pair);
    }
  });

  it('listSkills returns the same merged catalog on the same fixture', async () => {
    const pair = await makeSessionParityPair();
    try {
      // Same fixture on both sides: a user skill in each home (scrubbed to
      // `<HOME>` by the projection) and a project skill in the shared workDir.
      await writeSkill(join(pair.v1Home.raw, 'skills', 'parity-user-skill'), 'parity-user-skill');
      await writeSkill(join(pair.v2Home.raw, 'skills', 'parity-user-skill'), 'parity-user-skill');
      await writeSkill(
        join(pair.workDir, '.kimi-code', 'skills', 'parity-project-skill'),
        'parity-project-skill',
      );
      await createOnBoth(pair, { id: 'session_parity_skills' });
      const [v1Skills, v2Skills] = await Promise.all([
        pair.v1.listSkills({ sessionId: 'session_parity_skills' }),
        pair.v2.listSkills({ sessionId: 'session_parity_skills' }),
      ]);
      const project = KNOWN_DIFFS.listSkills;
      expect(normalize(project(v2Skills, pair.v2Home), 'name')).toEqual(
        normalize(project(v1Skills, pair.v1Home), 'name'),
      );
      // Non-vacuous: both fixture skills are present on both engines.
      for (const skills of [v1Skills, v2Skills]) {
        const names = skills.map((skill) => skill.name);
        expect(names).toContain('parity-user-skill');
        expect(names).toContain('parity-project-skill');
      }
    } finally {
      await closeSessionPair(pair);
    }
  });
});
