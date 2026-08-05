/**
 * RustRpcClient — the SDK's Rust engine-backed RPC client.
 *
 * Implements the same `SDKRpcClientBase` surface as the retired
 * KimiCore-backed `SDKRpcClient`, but every method talks to the Rust agent
 * engine (`@moonshot-ai/kimi-agent/rust-loop`) instead of an in-process JS
 * engine shell. The SDK `Session`/`KimiHarness` classes are unchanged —
 * they call the same CoreAPI RPC shape; only the wire beneath them differs.
 *
 * Wire translation: engine snake_case records → SDK camelCase shapes via
 * `./wire`; engine `host/event` → SDK `Event` passed through verbatim.
 * Engine sessions are process-wide with `session_id` routing, so one client
 * supports many sessions; host handlers are installed once on the engine
 * singleton.
 *
 * Capability policy: methods the engine RPC surface does not back yet fail
 * loud (`nativeUnavailable`) rather than fake a result, matching the
 * native-session convention.
 */
import type { SdkRpcSurface } from '../rpc';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'pathe';
import { load as loadYaml } from 'js-yaml';

import { SDKRpcClientBase } from '#/rpc';
import { ErrorCodes, KimiError } from '#/legacy/errors';
import { GlobalMcpConfigStore } from '#/legacy/global-mcp-config';
import { readZipEntries } from '#/legacy/session-export/zip';
import {
  beginGlobalMcpServerAuthHost,
  cancelGlobalMcpServerAuthHost,
  completeGlobalMcpServerAuthHost,
  resetGlobalMcpServerAuthHost,
  testGlobalMcpServerHost,
} from '#/legacy/mcp-host';
import {
  ensureConfigFile as legacyEnsureConfigFile,
  loadRuntimeConfigSafe,
  readConfigFile,
  resolveKimiHome,
  writeConfigFile,
} from '#/legacy/config';
import { DEFAULT_INIT_PROMPT } from '#/legacy/profile/default';
import type {
  JsonObject,
  KimiConfig,
  KimiHostIdentity,
  ListSessionsOptions,
  ResumedSessionSummary,
  SessionSummary,
  SkillSummary,
  TelemetryClient,
} from '#/types';

import {
  mapBackgroundTask,
  mapContextMessage,
  mapCronTaskSnapshot,
  mapMcpServer,
  mapMcpStartupMetrics,
  mapPluginInfo,
  mapPluginSummary,
  mapSkill,
  mapUsage,
  nativeUnavailable,
  promptText,
} from './wire';
import type {
  EngineSessionRecord,
  EngineSessionStatus,
} from './wire';

/**
 * The rust-loop surface `RustRpcClient` needs (structural subset of
 * `@moonshot-ai/kimi-agent/rust-loop`), injected for testability.
 */
export interface RustLoopApi {
  isRustEngineAvailable(): boolean;
  installSessionHostHandlers(handlers: {
    onEvent?: (event: unknown) => void;
    authorizeTool?: (req: unknown) => Promise<unknown>;
    llmChat?: (req: unknown) => Promise<unknown>;
    toolExecute?: (req: unknown) => Promise<unknown>;
  }): boolean;
  sessionCreate(options: {
    sessionId?: string;
    homedir?: string;
    systemPrompt?: string;
    model?: string;
    maxContextSize?: number;
    goalEnabled?: boolean;
    nativeLlm?: unknown;
    tools?: { name: string; description: string; inputSchema?: unknown }[];
    mcpServers?: unknown[];
    skills?: unknown[];
    hooks?: unknown[];
    workspaceTrusted?: boolean;
    llmStep?: (req: unknown) => Promise<unknown>;
  }): Promise<{ session_id: string } | null>;
  sessionList(): Promise<{ sessions: EngineSessionRecord[] } | null>;
  sessionGetStatus(sessionId: string): Promise<EngineSessionStatus | null>;
  sessionPrompt(
    sessionId: string,
    input: { type: 'text'; text: string }[],
    agentId?: string,
  ): Promise<{ stop_reason: string; steps: number; usage: unknown } | null>;
  sessionCancel(sessionId: string): Promise<{ cancelled: boolean } | null>;
  sessionSetModel(sessionId: string, model: string): Promise<{ ok: boolean } | null>;
  sessionSetThinking(sessionId: string, effort: string | null): Promise<{ ok: boolean } | null>;
  sessionSteer(
    sessionId: string,
    input: { type: 'text'; text: string }[],
  ): Promise<{ ok: boolean } | null>;
  sessionSetPlanMode(sessionId: string, enabled: boolean): Promise<{ ok: boolean } | null>;
  sessionSetSwarmMode(
    sessionId: string,
    enabled: boolean,
    trigger: string,
  ): Promise<{ ok: boolean } | null>;
  sessionListSkills(sessionId: string): Promise<{ skills: unknown[] } | null>;
  sessionActivateSkill(sessionId: string, name: string, args?: string): Promise<unknown>;
  sessionListMcpServers(sessionId: string): Promise<{ servers: unknown[] } | null>;
  sessionGetMcpStartupMetrics(sessionId: string): Promise<unknown>;
  sessionReconnectMcpServer(sessionId: string, name: string): Promise<unknown>;
  sessionGetUsage(sessionId: string): Promise<unknown>;
  sessionGetWarnings(sessionId: string): Promise<{ warnings: unknown[] } | null>;
  sessionGetContext(sessionId: string): Promise<unknown>;
  sessionClearContext(sessionId: string): Promise<unknown>;
  sessionImportContext(sessionId: string, content: string, source: string): Promise<unknown>;
  sessionGoalCreate(
    sessionId: string,
    input: { objective: string; completionCriterion?: string; replace?: boolean },
  ): Promise<unknown>;
  sessionGoalGet(sessionId: string): Promise<unknown>;
  sessionGoalPause(sessionId: string): Promise<unknown>;
  sessionGoalResume(sessionId: string): Promise<unknown>;
  sessionGoalCancel(sessionId: string): Promise<unknown>;
  sessionGetPlan(sessionId: string): Promise<unknown>;
  sessionClearPlan(sessionId: string): Promise<unknown>;
  sessionCompact(sessionId: string, instruction?: string): Promise<unknown>;
  sessionCancelCompaction(sessionId: string): Promise<{ cancelled: boolean } | null>;
  sessionUndoHistory(sessionId: string, count: number): Promise<unknown>;
  sessionAddAdditionalDir(
    sessionId: string,
    path: string,
  ): Promise<{ additional_dirs: string[] } | null>;
  sessionRemoveAdditionalDir(sessionId: string, path: string): Promise<unknown>;
  sessionUpdateMetadata(sessionId: string, patch: Record<string, unknown>): Promise<unknown>;
  sessionStartBtw(sessionId: string): Promise<{ btw_id: string } | null>;
  sessionEndBtw(sessionId: string): Promise<{ ended: boolean } | null>;
  sessionRunShell(
    sessionId: string,
    command: string,
    timeoutS?: number,
    commandId?: string,
  ): Promise<{ output: string | null; is_error: boolean; unavailable?: boolean } | null>;
  sessionCancelShellCommand(sessionId: string, commandId: string): Promise<unknown>;
  sessionSave(sessionId: string): Promise<{ ok: boolean } | null>;
  sessionLoad(sessionId: string): Promise<{ found: boolean } | null>;
  sessionDelete(sessionId: string): Promise<{ deleted: boolean } | null>;
  sessionExport(
    sessionId: string,
    homedir?: string,
    webLog?: string,
  ): Promise<{ session_id: string; zip_base64: string } | null>;
  sessionFork(input: {
    sessionId: string;
    forkId: string;
    title?: string;
    turnIndex?: number;
  }): Promise<{ forked: boolean } | null>;
  sessionDelete(sessionId: string): Promise<{ deleted: boolean } | null>;
  cronList(): Promise<{ tasks: unknown[] } | null>;
  bgList(): Promise<{ tasks: unknown[] } | null>;
  bgOutput(taskId: string): Promise<{ output: string } | null>;
  bgStop(taskId: string): Promise<unknown>;
  bgDetach(taskId: string): Promise<unknown>;
  pluginList(): Promise<{ plugins: unknown[] } | null>;
  pluginGet(id: string): Promise<unknown>;
  pluginInstall(source: string): Promise<unknown>;
  pluginSetEnabled(id: string, enabled: boolean): Promise<unknown>;
  pluginSetMcpEnabled(id: string, server: string, enabled: boolean): Promise<unknown>;
  pluginRemove(id: string): Promise<{ removed: boolean } | null>;
  pluginReload(): Promise<{ ok: boolean } | null>;
  configGet(): Promise<unknown>;
  configSet(patch: unknown): Promise<unknown>;
}

export interface RustRpcClientOptions {
  /** Real: `@moonshot-ai/kimi-agent/rust-loop`. */
  readonly rustLoop: RustLoopApi;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly identity?: KimiHostIdentity | undefined;
  readonly skillDirs?: readonly string[];
  readonly resolveOAuthTokenProvider?: unknown;
  readonly telemetry?: TelemetryClient;
  readonly onOAuthRefresh?: unknown;
  readonly uiMode?: string;
  /**
   * Host-proxy model step: answer one engine model request. When set, the
   * engine runs turns against this callback instead of a native-LLM provider
   * (the SDK's host-proxy path).
   */
  readonly llmStep?: (req: unknown) => Promise<unknown>;
}

/** A no-op telemetry client (default when the host supplies none). */
const noopTelemetryClient: TelemetryClient = {
  track: () => {},
  setContext: () => {},
};

/** Deep-merge a config patch onto a base (objects merge recursively; other
 *  values replace). `undefined`/null patch values keep the base. */
function deepMergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const existing = out[key];
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMergeConfig(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Map an engine session record onto the SDK `SessionSummary`. */
function mapSessionRecord(
  record: EngineSessionRecord,
  _homeDir: string,
): SessionSummary {
  const now = Date.now();
  return {
    id: record.id,
    title: record.title,
    workDir: record.work_dir ?? '',
    sessionDir: record.work_dir ?? '',
    createdAt: parseTime(record.created_at, now),
    updatedAt: parseTime(record.updated_at, now),
  };
}

function parseTime(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallback : ms;
}

// ── Host-side skill discovery ──────────────────────────────────────────
//
// The engine registry only knows skills the host hands it at `session/create`;
// listing is a host responsibility too. Discovery walks the two on-disk skill
// roots the SDK owns — `<workDir>/.kimi-code/skills` (project) and the brand
// dir `<KIMI_CODE_HOME>/skills` (user, resolveKimiHome-resolved) — and parses
// each `SKILL.md` frontmatter into a summary. Bodies are never exposed: the
// engine loads the text from `path`/`dir` at activation time.

/** A host-discovered skill bundle: frontmatter summary + disk locations. */
export interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSummary['source'];
  /** Absolute SKILL.md path (pathe-normalized forward slashes). */
  readonly path: string;
  /** Bundle directory; the engine falls back to it when resolving `path`. */
  readonly dir: string;
  readonly disableModelInvocation?: boolean;
}

const DISABLE_MODEL_INVOCATION_KEYS = [
  'disable_model_invocation',
  'disable-model-invocation',
  'disableModelInvocation',
] as const;

/** Walk one `<root>/skills/<name>/SKILL.md` root; unreadable entries and
 *  unparseable frontmatter are skipped (discovery is best-effort). */
async function discoverSkillBundles(
  rootDir: string,
  source: SkillSummary['source'],
): Promise<readonly DiscoveredSkill[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(rootDir);
  } catch {
    return [];
  }

  const skills: DiscoveredSkill[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const dir = join(rootDir, entry);
      const skillPath = join(dir, 'SKILL.md');
      let text: string;
      try {
        text = await readFile(skillPath, 'utf-8');
      } catch {
        return;
      }
      const parsed = parseSkillFrontmatter(text, entry);
      if (parsed === undefined) return;
      skills.push({
        name: parsed.name,
        description: parsed.description,
        source,
        path: skillPath,
        dir,
        ...(parsed.disableModelInvocation !== undefined
          ? { disableModelInvocation: parsed.disableModelInvocation }
          : {}),
      });
    }),
  );
  return skills;
}

/** Parse a SKILL.md's YAML frontmatter (name/description/
 *  disable_model_invocation). Missing fields fall back to the bundle dir name
 *  and an empty description; no parseable frontmatter yields undefined. */
function parseSkillFrontmatter(
  text: string,
  fallbackName: string,
):
  | { readonly name: string; readonly description: string; readonly disableModelInvocation?: boolean }
  | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) return undefined;

  const yamlText = lines.slice(1, close).join('\n').trim();
  let data: unknown;
  try {
    data = yamlText.length === 0 ? {} : (loadYaml(yamlText) ?? {});
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const frontmatter = data as Record<string, unknown>;

  const name =
    typeof frontmatter['name'] === 'string' && frontmatter['name'].trim().length > 0
      ? frontmatter['name'].trim()
      : fallbackName;
  const description =
    typeof frontmatter['description'] === 'string' ? frontmatter['description'].trim() : '';

  let disableModelInvocation: boolean | undefined;
  for (const key of DISABLE_MODEL_INVOCATION_KEYS) {
    if (typeof frontmatter[key] === 'boolean') {
      disableModelInvocation = frontmatter[key] as boolean;
      break;
    }
  }

  return {
    name,
    description,
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
  };
}

/** Map a discovered bundle onto the public `SkillSummary` surface (no body). */
function toSkillSummary(skill: DiscoveredSkill): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    path: skill.path,
    ...(skill.disableModelInvocation !== undefined
      ? { disableModelInvocation: skill.disableModelInvocation }
      : {}),
  };
}

export class RustRpcClient extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;

  private readonly rustLoop: RustLoopApi;
  private readonly llmStep: ((req: unknown) => Promise<unknown>) | undefined;
  /** SDK-owned sessionId → workDir map (the engine's work_dir is only
   *  populated when the host routes it through; the SDK is the authority). */
  private readonly workDirs = new Map<string, string>();
  /** Host mirror of sessions created by this client. The engine's store is
   *  process-global (shared across harnesses/tests), so listing must filter on
   *  what this client actually created rather than the whole store. */
  private readonly sessionSummaries = new Map<string, SessionSummary>();
  /** fork id → source session id, so the resumed summary can surface
   *  `sessionMetadata.forkedFrom`. */
  private readonly forkParents = new Map<string, string>();
  private readonly ready: Promise<SdkRpcSurface>;

  constructor(options: RustRpcClientOptions) {
    super();
    this.rustLoop = options.rustLoop;
    this.homeDir = options.homeDir ?? '';
    this.configPath = options.configPath ?? '';
    this.identity = options.identity;
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.llmStep = options.llmStep;
    this.rustLoop.installSessionHostHandlers({
      onEvent: (raw) => this.dispatchEngineEvent(raw),
      authorizeTool: (raw) => this.authorizeTool(raw),
      llmChat: async (raw) => {
        if (options.llmStep === undefined) {
          throw new Error('no llmStep provided');
        }
        const response = await options.llmStep(raw);
        // Host-proxy model step: the engine hands the token stream to the
        // host (it emits llm.delta for native-LLM turns only), so the SDK
        // re-emits the completed response content as one delta to keep the
        // Session.onEvent streaming-text contract for host-proxy sessions.
        const sessionId = (raw as { session_id?: string } | null)?.session_id;
        const text = (response as { content?: string } | null)?.content;
        if (sessionId !== undefined && sessionId.length > 0 && typeof text === 'string' && text.length > 0) {
          this.receiveEvent({
            type: 'llm.delta',
            part: { type: 'text', text },
            sessionId,
            agentId: this.interactiveAgentId,
          } as never);
        }
        return response;
      },
    });
    this.ready = Promise.resolve(this.buildRpc());
  }

  // ── Event + approval plumbing ──────────────────────────────────────────

  /** Pass an engine `host/event` through verbatim (protocol-toward-engine):
   *  the engine emits the SDK event shape (snake_case) already, so the host
   *  only stamps the `sessionId`/`agentId` routing fields. Side-question
   *  (btw) turns carry the engine's `btw-<sid>` session id; they belong to
   *  the parent session, so map them back onto it. */
  private dispatchEngineEvent(raw: unknown): void {
    const event = (raw ?? {}) as { type?: string; session_id?: string | null };
    const rawSessionId = event.session_id ?? '';
    if (rawSessionId.length === 0) return;
    const sessionId = rawSessionId.startsWith('btw-')
      ? rawSessionId.slice('btw-'.length)
      : rawSessionId;
    const { session_id: _drop, ...payload } = event;
    this.receiveEvent({ ...payload, sessionId, agentId: 'main' } as never);
  }

  private async authorizeTool(raw: unknown): Promise<{ block: boolean; resolved: boolean }> {
    const req = (raw ?? {}) as {
      session_id?: string | null;
      tool_name?: string;
      tool_call_id?: string;
      arguments?: unknown;
    };
    const sessionId = req.session_id ?? '';
    // The base class routes to the per-session handler set by
    // `Session.setApprovalHandler`; no handler → auto-allow (permission auto).
    const response = await this.requestApproval({
      sessionId,
      agentId: 'main',
      toolCallId: req.tool_call_id ?? '',
      toolName: req.tool_name ?? '',
      action: req.tool_name ?? '',
      display: { kind: 'generic', summary: req.tool_name ?? '', detail: req.arguments },
    });
    return { block: response.decision !== 'approved', resolved: true };
  }

  // ── CoreAPI implementation ─────────────────────────────────────────────

  private buildRpc(): SdkRpcSurface {
    const r = this.rustLoop;
    // Wide implementation type: the exact CoreAPI shape is enforced at the
    // return boundary (see the cast below); payload fields are structurally
    // matched per method.
    const impl: Record<string, unknown> = {
      // ── Session lifecycle ──────────────────────────────────────────────
      createSession: async ({ id, workDir, model, additionalDirs, permission, metadata }: any) => {
        // Model resolution is host-side: an explicit option wins, else the
        // host config's defaultModel (config is SDK-owned data).
        const effectiveModel = model ?? readConfigFile(this.configPath).defaultModel;
        // On-disk project/brand skills the engine registry must know before
        // `session/activate_skill` can resolve them. The engine loads each
        // body from `path`/`dir` at activation; the SDK summary surface never
        // exposes the body itself.
        const discovered =
          workDir !== undefined && workDir.trim().length > 0
            ? await this.discoverSkills(workDir)
            : [];
        const created = await r.sessionCreate({
          sessionId: id,
          homedir: this.homeDir,
          model: effectiveModel,
          // Host-resolved model window: the engine enforces context-budget
          // limits (import overflow) against this.
          maxContextSize: readConfigFile(this.configPath).models?.[effectiveModel]?.maxContextSize,
          llmStep: this.llmStep,
          // Builtin prompt skills the engine registry must know for
          // host RPCs like `generateAgentsMd` (session.init). The engine
          // persists none of these; the host supplies flat records.
          skills: [
            {
              name: 'init',
              description: 'Analyze the codebase and generate AGENTS.md',
              skillType: 'prompt',
              source: 'builtin',
              content: DEFAULT_INIT_PROMPT,
            },
            ...discovered.map((skill) => ({
              name: skill.name,
              description: skill.description,
              skillType: 'prompt',
              source: skill.source,
              path: skill.path,
              dir: skill.dir,
            })),
          ],
        });
        if (created === null) {
          throw new Error('Rust engine unavailable: cannot create session');
        }
        const sessionId = created.session_id;
        if (workDir !== undefined && workDir.length > 0) {
          this.workDirs.set(sessionId, workDir);
        }
        // Apply the effective permission mode: explicit option wins, else the
        // host config's default_permission_mode (the engine gate is
        // process-wide; the last-set mode is the session-visible one).
        const effectivePermission =
          permission ?? readConfigFile(this.configPath).defaultPermissionMode;
        if (effectivePermission !== undefined) {
          await (
            r as unknown as { permissionSetMode?(mode: string): Promise<unknown> }
          ).permissionSetMode?.(effectivePermission);
        }
        // Initial metadata is host-owned session state: mirror it locally and
        // hand it to the engine (the resumed summary reads it back from the
        // host mirror; the engine persists it with the session record).
        const initialMetadata = (metadata ?? {}) as Record<string, unknown>;
        if (Object.keys(initialMetadata).length > 0) {
          await r.sessionUpdateMetadata(sessionId, {
            custom: initialMetadata as JsonObject,
          });
        }
        const now = Date.now();
        const summary: SessionSummary = {
          id: sessionId,
          workDir,
          sessionDir: workDir,
          createdAt: now,
          updatedAt: now,
          metadata: initialMetadata as JsonObject,
          additionalDirs: additionalDirs ?? [],
        };
        this.sessionSummaries.set(sessionId, summary);
        return summary;
      },
      closeSession: async ({ sessionId }: any) => {
        await r.sessionSave(sessionId);
        this.clearSessionHandlers(sessionId);
      },
      listSessions: async ({ workDir, sessionId }: ListSessionsOptions) => {
        if (typeof workDir === 'string' && workDir.trim() === '') {
          throw new KimiError(
            ErrorCodes.REQUEST_WORK_DIR_REQUIRED,
            'listSessions requires workDir',
          );
        }
        // Host mirror: list what this client created, so a harness only sees
        // its own sessions even though the engine store is process-global.
        const summaries = Array.from(this.sessionSummaries.values());
        return summaries.filter(
          (summary) =>
            (workDir === undefined || summary.workDir === workDir) &&
            (sessionId === undefined || summary.id === sessionId),
        );
      },
      resumeSession: async ({ sessionId }: any) => {
        await r.sessionLoad(sessionId);
        const status = await r.sessionGetStatus(sessionId);
        const summary = await this.sessionSummaryFor(sessionId);
        return this.resumedSummary(summary, status, await this.replayFor(sessionId));
      },
      reloadSession: async ({ sessionId }: any) => {
        const found = await r.sessionLoad(sessionId);
        if (!found) throw new Error('Session not found for reload');
        const status = await r.sessionGetStatus(sessionId);
        const summary = await this.sessionSummaryFor(sessionId);
        return this.resumedSummary(summary, status, await this.replayFor(sessionId));
      },
      forkSession: async ({ sessionId, id, title, workDir, metadata, turnIndex }: any) => {
        let result: { forked: boolean } | null;
        try {
          result = await r.sessionFork({
            sessionId,
            forkId: id ?? `${sessionId}_fork`,
            title,
            turnIndex,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('active turn')) {
            throw new KimiError(
              ErrorCodes.SESSION_FORK_ACTIVE_TURN,
              'Cannot fork a session with an active turn',
            );
          }
          if (message.includes('out of range')) {
            const match = message.match(/out of range: (-?\d+) >= (-?\d+)/);
            throw new KimiError(ErrorCodes.REQUEST_INVALID, message, {
              details: {
                turnIndex: Number(match?.[1] ?? turnIndex),
                availableTurns: Number(match?.[2] ?? 0),
              },
            });
          }
          if (message.includes('negative')) {
            throw new KimiError(ErrorCodes.REQUEST_INVALID, message, {
              details: { turnIndex },
            });
          }
          throw error;
        }
        if (!result || !result.forked) {
          throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
        }
        const forkId = id ?? `${sessionId}_fork`;
        const now = Date.now();
        // The fork inherits the source's custom metadata and merges the
        // caller's overrides; the kept conversation's last user prompt
        // becomes the fork's `lastPrompt` (read back from the engine).
        const sourceMetadata = this.sessionSummaries.get(sessionId)?.metadata ?? {};
        const mergedMetadata = { ...sourceMetadata, ...metadata };
        let lastPrompt: string | undefined;
        try {
          const context = await r.sessionGetContext(forkId);
          lastPrompt = lastUserPromptFromContext(context);
        } catch {
          // Engine context unavailable; leave lastPrompt unset.
        }
        const summary: SessionSummary = {
          id: forkId,
          workDir: workDir ?? this.workDirs.get(sessionId) ?? '',
          sessionDir: workDir ?? this.workDirs.get(sessionId) ?? '',
          title,
          createdAt: now,
          updatedAt: now,
          metadata: mergedMetadata,
          ...(lastPrompt !== undefined ? { lastPrompt } : {}),
        };
        if (summary.workDir.length > 0) this.workDirs.set(forkId, summary.workDir);
        this.sessionSummaries.set(forkId, summary);
        this.forkParents.set(forkId, sessionId);
        // Surface the resumed shape so the fresh fork Session carries
        // sessionMetadata (title/custom/forkedFrom/agents) immediately.
        return {
          ...summary,
          sessionMetadata: {
            createdAt: String(now),
            updatedAt: String(now),
            title: title ?? summary.id,
            isCustomTitle: title !== undefined,
            ...(summary.workDir.length > 0 ? { workDir: summary.workDir } : {}),
            custom: mergedMetadata,
            agents: { main: {} },
            ...(lastPrompt !== undefined ? { lastPrompt } : {}),
            forkedFrom: sessionId,
          },
          agents: { main: {} },
        } as never;
      },
      archiveSession: async () => nativeUnavailable('archiveSession'),
      deleteSession: async ({ sessionId }: any) => {
        const result = await r.sessionDelete(sessionId);
        if (!result || !result.deleted) {
          throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
        }
        this.workDirs.delete(sessionId);
        this.sessionSummaries.delete(sessionId);
        this.clearSessionHandlers(sessionId);
      },
      exportSession: async ({ sessionId }: any) => {
        // The engine persists sessions in its own store; fetch its wire
        // records so the host-side export archive can include them. The engine
        // bundles session files only when `homedir` is a real path — pass ''
        // so the archive carries just the records (the host re-assembles the
        // zip in the SDK layout). Unknown sessions export an empty record set.
        let result: { session_id: string; zip_base64: string } | null;
        try {
          result = await r.sessionExport(sessionId, '');
        } catch {
          result = null;
        }
        if (result === null) return { wireRecords: [] };
        let entries: Map<string, Buffer>;
        try {
          entries = readZipEntries(Buffer.from(result.zip_base64, 'base64'));
        } catch {
          return { wireRecords: [] };
        }
        return { wireRecords: parseEngineWireRecords(entries.get('wire.json')) };
      },

      // ── Turn control ───────────────────────────────────────────────────
      prompt: async ({ sessionId, agentId, input }: any) => {
        const text = promptText(input);
        if (text.trim().length === 0) {
          throw new KimiError(
            ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY,
            'Prompt input must not be empty',
          );
        }
        // Route to the interactive side agent (`btw-<sid>`) when the caller
        // is inside `withInteractiveAgent`; the engine answers main-agent
        // turns when agentId is absent or not a btw id.
        await r.sessionPrompt(sessionId, [{ type: 'text', text }], agentId);
      },
      steer: async ({ sessionId, input }: any) => {
        await r.sessionSteer(sessionId, [{ type: 'text', text: promptText(input) }]);
      },
      cancel: async ({ sessionId }: any) => {
        await r.sessionCancel(sessionId);
      },
      generateAgentsMd: async ({ sessionId }: any) => {
        await r.sessionActivateSkill(sessionId, 'init');
      },
      setModel: async ({ sessionId, model }: any) => {
        await r.sessionSetModel(sessionId, model);
      },
      setThinking: async ({ sessionId, effort }: any) => {
        await r.sessionSetThinking(sessionId, effort ?? null);
      },
      setPermission: async ({ sessionId: _sessionId, mode }: any) => {
        // The engine gate mode is process-wide; a per-session value is
        // approximated by the last-set mode (documented limitation).
        await (r as unknown as { permissionSetMode?(mode: string): Promise<unknown> })
          .permissionSetMode?.(mode);
      },
      enterPlan: async ({ sessionId }: any) => {
        await r.sessionSetPlanMode(sessionId, true);
      },
      cancelPlan: async ({ sessionId }: any) => {
        await r.sessionSetPlanMode(sessionId, false);
      },
      clearPlan: async ({ sessionId }: any) => {
        await r.sessionClearPlan(sessionId);
      },
      enterSwarm: async ({ sessionId, trigger }: any) => {
        await r.sessionSetSwarmMode(sessionId, true, trigger);
      },
      exitSwarm: async ({ sessionId }: any) => {
        await r.sessionSetSwarmMode(sessionId, false, 'exit');
      },
      getSwarmMode: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return status?.swarm_mode ?? false;
      },
      beginCompaction: async ({ sessionId, instruction }: any) => {
        try {
          await r.sessionCompact(sessionId, instruction);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('No compaction delegate set')) {
            // No native-LLM summarizer is configured; map to the SDK's
            // `compaction.unable` contract instead of leaking the engine
            // message (mirrors the forkSession active-turn mapping above).
            throw new KimiError(
              ErrorCodes.COMPACTION_UNABLE,
              'Compaction is unavailable for this session',
            );
          }
          throw error;
        }
      },
      cancelCompaction: async ({ sessionId }: any) => {
        await r.sessionCancelCompaction(sessionId);
      },
      registerTool: async () => {},
      unregisterTool: async () => {},
      setActiveTools: async () => {},
      getTools: async () => [] as never,
      addAdditionalDir: async ({ sessionId, path, persist: _persist }: any) => {
        // NOTE: the engine `session/add_additional_dir` RPC has no `persist`
        // parameter today — the SDK flag is accepted for contract parity but
        // silently dropped by the wire (persisted vs ephemeral dirs is an
        // engine-side gap; see RUST_MIGRATION_PLAN TODO).
        await r.sessionAddAdditionalDir(sessionId, path);
        // Mirror the caller's path into the host summary (the engine returns
        // its canonical form, which on Windows resolves 8.3 short names —
        // the SDK surfaces what the caller added). Normalized to the SDK's
        // forward-slash convention.
        const normalizedPath = normalizeHostPath(path);
        const summary = this.sessionSummaries.get(sessionId);
        const existing = summary?.additionalDirs ?? [];
        const additionalDirs = existing.includes(normalizedPath)
          ? existing
          : [...existing, normalizedPath];
        if (summary !== undefined) {
          this.sessionSummaries.set(sessionId, { ...summary, additionalDirs });
        }
        return { additionalDirs };
      },
      updateSessionMetadata: async ({ sessionId, metadata }: any) => {
        await r.sessionUpdateMetadata(sessionId, metadata ?? {});
        // Mirror the patch into the host session summary (custom metadata is
        // host-owned state the resumed summary reads back).
        const summary = this.sessionSummaries.get(sessionId);
        if (summary !== undefined) {
          const patch = (metadata as { custom?: JsonObject } | null)?.custom;
          if (patch !== undefined && Object.keys(patch).length > 0) {
            this.sessionSummaries.set(sessionId, {
              ...summary,
              metadata: { ...summary.metadata, ...patch } as JsonObject,
            });
          }
        }
      },
      renameSession: async ({ sessionId, title }: any) => {
        // Missing sessions are unknown to the engine agent map ("no agent for
        // session"); surface the SDK's session.not_found contract instead.
        if (!this.sessionSummaries.has(sessionId)) {
          throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `Session not found: ${sessionId}`, {
            details: { sessionId },
          });
        }
        await r.sessionUpdateMetadata(sessionId, { title });
        const summary = this.sessionSummaries.get(sessionId);
        if (summary !== undefined) {
          this.sessionSummaries.set(sessionId, { ...summary, title });
          await this.patchSessionStateFile(summary.sessionDir, {
            title,
            isCustomTitle: true,
          }).catch(() => {});
        }
      },
      runShellCommand: async ({ sessionId, command, commandId }: any) => {
        const result = await r.sessionRunShell(sessionId, command, undefined, commandId);
        if (result?.unavailable) return { stdout: '', stderr: '', isError: true };
        return {
          stdout: result?.output ?? '',
          stderr: '',
          isError: result?.is_error,
        };
      },
      cancelShellCommand: async ({ sessionId, commandId }: any) => {
        await r.sessionCancelShellCommand(sessionId, commandId);
      },
      startBtw: async ({ sessionId }: any) => {
        const result = await r.sessionStartBtw(sessionId);
        return result?.btw_id ?? '';
      },

      // ── State reads ────────────────────────────────────────────────────
      getConfig: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        if (status === null) throw new Error('Session not found');
        return {
          modelAlias: status.model ?? undefined,
          provider: status.model !== undefined && status.model !== null ? { model: status.model } : undefined,
          thinkingEffort: status.thinking_effort,
          modelCapabilities: {
            max_context_tokens: status.max_context_tokens,
            max_input_tokens: status.max_context_tokens,
          },
          planMode: status.plan_mode,
          swarmMode: status.swarm_mode,
        } as never;
      },
      getPermission: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return { mode: status?.permission ?? 'manual' } as never;
      },
      getModel: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return status?.model ?? '';
      },
      getSessionMetadata: async ({ sessionId }: any) => {
        const status = await r.sessionGetStatus(sessionId);
        return {
          createdAt: '0',
          updatedAt: '0',
          title: sessionId,
          isCustomTitle: false,
          custom: {},
          agents: {},
          ...(status?.model !== undefined ? { model: status.model } : {}),
        } as never;
      },
      getUsage: async ({ sessionId }: any) => {
        return mapUsage(await r.sessionGetUsage(sessionId)) as never;
      },
      getSessionWarnings: async ({ sessionId }: any) => {
        const result = await r.sessionGetWarnings(sessionId);
        return (result?.warnings ?? []) as never;
      },
      listSkills: async ({ sessionId }: any) => {
        // Merge the engine registry (skills registered at session/create) with
        // a fresh host-side discovery over the session's workDir. Host
        // discovery wins on same-name overlap: it carries the disk path and
        // frontmatter flags (`disableModelInvocation`) the engine record omits.
        const result = await r.sessionListSkills(sessionId);
        const engineSkills = (result?.skills ?? []).map((s) => mapSkill(s as never));
        const workDir = this.workDirs.get(sessionId);
        const discovered =
          workDir === undefined ? [] : (await this.discoverSkills(workDir)).map(toSkillSummary);
        const byName = new Map<string, SkillSummary>();
        for (const skill of engineSkills) byName.set(skill.name, skill);
        for (const skill of discovered) byName.set(skill.name, skill);
        return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
      },
      activateSkill: async ({ sessionId, name, args }: any) => {
        await r.sessionActivateSkill(sessionId, name, args);
      },
      listMcpServers: async ({ sessionId }: any) => {
        const result = await r.sessionListMcpServers(sessionId);
        return (result?.servers ?? []).map((s) => mapMcpServer(s as never));
      },
      getMcpStartupMetrics: async ({ sessionId }: any) => {
        return mapMcpStartupMetrics(await r.sessionGetMcpStartupMetrics(sessionId)) as never;
      },
      reconnectMcpServer: async ({ sessionId, name }: any) => {
        await r.sessionReconnectMcpServer(sessionId, name);
      },
      getContext: async ({ sessionId }: any) => {
        const raw = await r.sessionGetContext(sessionId);
        return this.mapContext(raw) as never;
      },
      clearContext: async ({ sessionId }: any) => {
        await r.sessionClearContext(sessionId);
      },
      importContext: async ({ sessionId, content, source }: any) => {
        try {
          await r.sessionImportContext(sessionId, content, source);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('cannot be empty')) {
            throw new KimiError(ErrorCodes.REQUEST_INVALID, message, {
              details: { reason: 'import_content_empty' },
            });
          }
          if (message.includes('exceed the context limit')) {
            const match = message.match(/exceed the context limit: (\d+) > (\d+)/);
            throw new KimiError(ErrorCodes.CONTEXT_OVERFLOW, message, {
              details: {
                reason: 'import_context_overflow',
                currentTokenCount: Number(match?.[1] ?? 0),
                maxContextTokens: Number(match?.[2] ?? 0),
              },
            });
          }
          throw error;
        }
      },
      undoHistory: async ({ sessionId, count }: any) => {
        await r.sessionUndoHistory(sessionId, count ?? 1);
      },
      getPlan: async ({ sessionId }: any) => {
        return (await r.sessionGetPlan(sessionId)) as never;
      },
      createGoal: async ({ sessionId, objective, completionCriterion, replace }: any) => {
        return (await r.sessionGoalCreate(sessionId, {
          objective,
          completionCriterion,
          replace: replace ?? false,
        })) as never;
      },
      getGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalGet(sessionId)) as never;
      },
      pauseGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalPause(sessionId)) as never;
      },
      resumeGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalResume(sessionId)) as never;
      },
      cancelGoal: async ({ sessionId }: any) => {
        return (await r.sessionGoalCancel(sessionId)) as never;
      },
      getCronTasks: async () => {
        const result = await r.cronList();
        return { tasks: (result?.tasks ?? []).map(mapCronTaskSnapshot) } as never;
      },
      getBackground: async () => {
        const result = await r.bgList();
        return (result?.tasks ?? []).map((t) => mapBackgroundTask(t)) as never;
      },
      getBackgroundOutput: async ({ taskId }: any) => {
        const result = await r.bgOutput(taskId);
        return (result?.output ?? '') as never;
      },
      stopBackground: async ({ taskId }: any) => {
        // Stopping an unknown task is a no-op (v1 semantics), not an error.
        try {
          await r.bgStop(taskId);
        } catch (error) {
          if (isTaskNotFound(error)) return;
          throw error;
        }
      },
      detachBackground: async ({ taskId }: any) => {
        await r.bgDetach(taskId);
      },
      waitForBackgroundTasksOnPrint: async () => {},
      handlePrintMainTurnCompleted: async () => 'finish' as const,

      // ── Harness-level config / plugins ─────────────────────────────────
      getCoreInfo: async () => {
        return { version: this.identity?.version ?? '' } as never;
      },
      getExperimentalFeatures: async () => [] as never,
      getKimiConfig: async () => {
        // Config is host data: read the SDK-owned config.toml locally (the
        // engine's config/get serves the engine's own resolved view). The
        // lenient read salvages broken-but-fixable sections (v1 degraded
        // startup: an invalid model alias is dropped, not fatal) and reports
        // the drops through getConfigDiagnostics.
        const loaded = loadRuntimeConfigSafe(this.configPath);
        return loaded.config;
      },
      setKimiConfig: async (patch: any) => {
        // Deep-merge the patch onto the on-disk config and persist it
        // locally (v1 config semantics live host-side, not in the engine).
        const base = readConfigFile(this.configPath);
        const merged = deepMergeConfig(base, patch ?? {});
        // The legacy writer's config type is its own schema; the SDK config
        // shape is structurally compatible (both camelCase KimiConfig).
        await writeConfigFile(
          this.configPath,
          merged as unknown as Parameters<typeof writeConfigFile>[1],
        );
        return merged as KimiConfig;
      },
      removeKimiProvider: async () => {
        // Host config semantics (parity with setKimiConfig): drop the
        // `providers.kimi` section from the SDK-owned config.toml.
        const base = readConfigFile(this.configPath);
        const providers = base.providers as Record<string, unknown> | undefined;
        if (providers && typeof providers === 'object') {
          delete providers['kimi'];
          await writeConfigFile(
            this.configPath,
            base as unknown as Parameters<typeof writeConfigFile>[1],
          );
        }
      },
      getConfigDiagnostics: async () => {
        const loaded = loadRuntimeConfigSafe(this.configPath);
        return {
          warnings: [...loaded.fileWarnings, ...loaded.envWarnings],
        } as never;
      },
      listGlobalMcpServers: async () => new GlobalMcpConfigStore(this.homeDir).list(),
      addGlobalMcpServer: async ({ server }: any) =>
        new GlobalMcpConfigStore(this.homeDir).add(server),
      updateGlobalMcpServer: async ({ server }: any) =>
        new GlobalMcpConfigStore(this.homeDir).update(server),
      removeGlobalMcpServer: async ({ name }: any) =>
        new GlobalMcpConfigStore(this.homeDir).remove(name),
      beginGlobalMcpServerAuth: async ({ name }: any) => {
        const server = await new GlobalMcpConfigStore(this.homeDir).get(name);
        return beginGlobalMcpServerAuthHost(server);
      },
      completeGlobalMcpServerAuth: async ({ flowId }: any) => {
        completeGlobalMcpServerAuthHost(flowId);
      },
      cancelGlobalMcpServerAuth: async ({ flowId }: any) => {
        cancelGlobalMcpServerAuthHost(flowId);
      },
      resetGlobalMcpServerAuth: async ({ name }: any) => {
        const server = await new GlobalMcpConfigStore(this.homeDir).get(name);
        resetGlobalMcpServerAuthHost(server);
      },
      testGlobalMcpServer: async ({ name }: any) => {
        const server = await new GlobalMcpConfigStore(this.homeDir).get(name);
        return testGlobalMcpServerHost(server);
      },
      listWorkspaceSkills: async ({ workDir }: any) => {
        if (typeof workDir !== 'string' || workDir.trim() === '') {
          throw new KimiError(
            ErrorCodes.REQUEST_WORK_DIR_REQUIRED,
            'listWorkspaceSkills requires workDir',
          );
        }
        return (await this.discoverSkills(workDir)).map(toSkillSummary);
      },
      listPlugins: async () => {
        const result = await r.pluginList();
        return (result?.plugins ?? []).map((p) => mapPluginSummary(p as never)) as never;
      },
      getPluginInfo: async ({ id }: any) => {
        return mapPluginInfo((await r.pluginGet(id)) as never) as never;
      },
      installPlugin: async ({ source }: any) => {
        const summary = await r.pluginInstall(source);
        return mapPluginSummary(summary as never) as never;
      },
      setPluginEnabled: async ({ id, enabled }: any) => {
        await r.pluginSetEnabled(id, enabled);
      },
      setPluginMcpServerEnabled: async ({ id, server, enabled }: any) => {
        await r.pluginSetMcpEnabled(id, server, enabled);
      },
      removePlugin: async ({ id }: any) => {
        await r.pluginRemove(id);
      },
      reloadPlugins: async () => {
        await r.pluginReload();
        return { added: 0, removed: 0, changed: 0, unchanged: 0 };
      },
      listPluginCommands: async () => [],
      activatePluginCommand: async () => nativeUnavailable('activatePluginCommand'),
    };
    return impl as unknown as SdkRpcSurface;
  }

  private async patchSessionStateFile(
    sessionDir: string | undefined,
    patch: Record<string, unknown>,
  ): Promise<void> {
    if (sessionDir === undefined || sessionDir.length === 0) return;
    const statePath = join(sessionDir, 'state.json');
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // No host-side state.json (Rust engine persists sessions in its own
      // store); nothing to sync.
      return;
    }
    await writeFile(statePath, `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Discover project + brand skills visible to `workDir` (project wins on a
   *  same-name collision; results are name-sorted for determinism). The brand
   *  root is `<KIMI_CODE_HOME>/skills` via the same resolveKimiHome resolution
   *  the harness uses — never the OS home. */
  private async discoverSkills(workDir: string): Promise<readonly DiscoveredSkill[]> {
    const byName = new Map<string, DiscoveredSkill>();
    const roots: ReadonlyArray<[string, SkillSummary['source']]> = [
      [join(workDir, '.kimi-code', 'skills'), 'project'],
      [join(resolveKimiHome(this.homeDir), 'skills'), 'user'],
    ];
    for (const [root, source] of roots) {
      for (const skill of await discoverSkillBundles(root, source)) {
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  private async sessionSummaryFor(sessionId: string): Promise<SessionSummary> {
    const records = (await this.rustLoop.sessionList())?.sessions ?? [];
    const record = records.find((r) => r.id === sessionId);
    const summary = mapSessionRecord(
      record ?? { id: sessionId, created_at: '', updated_at: '', title: '', work_dir: '' },
      this.homeDir,
    );
    const sdkWorkDir = this.workDirs.get(sessionId);
    const mirror = this.sessionSummaries.get(sessionId);
    const withMetadata = {
      ...summary,
      ...(mirror?.metadata !== undefined && Object.keys(mirror.metadata).length > 0
        ? { metadata: mirror.metadata }
        : {}),
      ...(mirror?.additionalDirs !== undefined && mirror.additionalDirs.length > 0
        ? { additionalDirs: mirror.additionalDirs }
        : {}),
    };
    if (sdkWorkDir !== undefined) {
      return { ...withMetadata, workDir: sdkWorkDir, sessionDir: sdkWorkDir };
    }
    return withMetadata;
  }

  private resumedSummary(
    summary: SessionSummary,
    _status: EngineSessionStatus | null,
    replay?: unknown,
  ): ResumedSessionSummary {
    const now = Date.now();
    const forkedFrom = this.forkParents.get(summary.id);
    const mainAgent = (replay !== undefined ? { replay } : {}) as ResumedSessionSummary['agents'][string];
    return {
      ...summary,
      sessionMetadata: {
        createdAt: String(summary.createdAt),
        updatedAt: String(summary.updatedAt),
        title: summary.title ?? summary.id,
        isCustomTitle: false,
        ...(summary.workDir !== undefined ? { workDir: summary.workDir } : {}),
        custom: {},
        // The engine tracks no per-agent state on the wire; the main agent is
        // the only agent the SDK surfaces at resume.
        agents: { main: {} },
        ...(forkedFrom !== undefined ? { forkedFrom } : {}),
      },
      agents: { main: mainAgent },
      warning: undefined,
      createdAt: summary.createdAt,
      updatedAt: now,
    };
  }

  /** Build the main-agent replay records from the engine's context history
   *  (message-level records; the SDK's resume surface reads them back). */
  private async replayFor(sessionId: string): Promise<unknown> {
    try {
      const context = await this.rustLoop.sessionGetContext(sessionId);
      return replayFromContext(context);
    } catch {
      return [];
    }
  }

  private mapContext(raw: unknown): unknown {
    if (raw === null || typeof raw !== 'object') return { history: [], tokenCount: 0 };
    const obj = raw as Record<string, unknown>;
    const history = Array.isArray(obj['history'])
      ? (obj['history'] as Record<string, unknown>[]).map(mapContextMessage)
      : [];
    return {
      history,
      tokenCount: typeof obj['token_count'] === 'number' ? obj['token_count'] : 0,
      ...(obj['projectRoot'] !== undefined ? { projectRoot: obj['projectRoot'] } : {}),
      ...(obj['cwd'] !== undefined ? { cwd: obj['cwd'] } : {}),
      ...(obj['additionalDirs'] !== undefined ? { additionalDirs: obj['additionalDirs'] } : {}),
    };
  }

  async ensureConfigFile(): Promise<void> {
    // Config is host data: materialize the default scaffold under the SDK's
    // config path (the engine does not own the host config file).
    await legacyEnsureConfigFile(this.configPath);
  }

  async close(): Promise<void> {
    // The engine process is host-owned; nothing to release client-side.
  }

  protected async getRpc(): Promise<SdkRpcSurface> {
    return this.ready;
  }
}

function isTaskNotFound(error: unknown): boolean {
  return /task .* not found/i.test(error instanceof Error ? error.message : String(error));
}

/** Parse the engine's `wire.json` (a JSON array of record objects) into the
 *  array the host writes out as `agents/main/wire.jsonl`. Malformed or missing
 *  records yield an empty list — the export proceeds without wire content. */
function parseEngineWireRecords(entry: Buffer | undefined): unknown[] {
  if (entry === undefined) return [];
  try {
    const parsed = JSON.parse(entry.toString('utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Map an engine context snapshot (`{ history: [...] }`) to SDK replay
 *  message records, preserving the conversation the fork kept. User messages
 *  carry a `{ kind: 'user' }` origin; assistant messages none (matching the
 *  SDK's `visibleReplayText` filter). */
function replayFromContext(raw: unknown): unknown[] {
  if (raw === null || typeof raw !== 'object') return [];
  const history = (raw as Record<string, unknown>)['history'];
  if (!Array.isArray(history)) return [];
  const records: unknown[] = [];
  for (const value of history) {
    if (typeof value !== 'object' || value === null) continue;
    const message = value as Record<string, unknown>;
    if (typeof message['role'] !== 'string') continue;
    const role = message['role'] as string;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = Array.isArray(message['content']) ? message['content'] : [];
    const textParts = (content as Record<string, unknown>[])
      .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
      .map((part) => ({ type: 'text' as const, text: part['text'] as string }));
    const origin =
      message['origin'] !== null && typeof message['origin'] === 'object'
        ? ((message['origin'] as Record<string, unknown>)['kind'] as
            | 'user'
            | 'shell_command'
            | undefined)
        : undefined;
    records.push({
      type: 'message',
      message: {
        role,
        content: textParts,
        toolCalls: [],
        ...(origin !== undefined ? { origin: { kind: origin } } : {}),
      },
    });
  }
  return records;
}

/** The text of the last user message in an engine context snapshot (used as
 *  the fork's `lastPrompt` after a historical fork). */
function lastUserPromptFromContext(raw: unknown): string | undefined {
  const records = replayFromContext(raw);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i] as { type?: string; message?: { role?: string; content?: { text?: string }[] } };
    if (record.type !== 'message') continue;
    if (record.message?.role !== 'user') continue;
    const text = (record.message.content ?? [])
      .map((part) => part.text ?? '')
      .join('');
    if (text.trim().length > 0) return text;
  }
  return undefined;
}

/** Normalize an engine-returned path to the SDK's forward-slash convention
 *  (strips the Windows `\\?\` verbatim prefix and converts separators). */
function normalizeHostPath(path: string): string {
  return path.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
}
