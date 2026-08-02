/**
 * `/skills` REST routes (session- and workspace-scoped) — server-v2 port.
 *
 * Mirrors the v1 server's wire contract
 * (`packages/server/src/routes/skills.ts`) path-for-path and schema-for-schema:
 *
 *   GET  /sessions/{session_id}/skills                       data: {skills: SkillDescriptor[]}
 *   GET  /workspaces/{workspace_id}/skills                   data: {skills: SkillDescriptor[]}
 *   POST /sessions/{session_id}/skills/{skill_name}:activate body: {args?}  data: {activated: true, skill_name}
 *
 * The session list is session-scoped: the catalog is built per session
 * (project skills are discovered from the session cwd), so it lives under
 * `/sessions/{session_id}` rather than as a global collection like `/tools`.
 *
 * The workspace list (`/workspaces/{workspace_id}/skills`) is the session-less
 * counterpart: it scans the same roots a new session in that workspace cwd
 * would, so clients can populate the composer skill menu before a session
 * exists. The workspace id is resolved to its root via
 * `IWorkspaceService.get` (`40410` when unknown); the root is then scanned by
 * composing the same five sources the per-session catalog merges — builtin /
 * user / extra / project(workDir) / plugin — through the shared `ISkillDiscovery`,
 * `skillRoots` and `InMemorySkillCatalog` primitives, so the result matches the
 * session listing for the same cwd. The composition is intentionally edge-side:
 * `InMemorySkillCatalog` is not a scoped service and the `skillRoots` helpers
 * are exported for exactly this purpose.
 *
 * **Activation gate**: by convention the session endpoints are only valid for
 * an *activated* session — one that is live in a workspace handler's session
 * registry. When
 * the session is not in the live map we still answer `40401 session.not_found`
 * (the only session error code on the v1 wire contract), but we enrich the
 * message:
 *   - persisted in `ISessionIndex` but not live → `"... is not activated, you need to activate it first"`;
 *   - not in the index at all                  → `"... does not exist"`.
 *
 * **Scope split**: v1 resolves a single `ISkillService` for every verb. v2
 * splits the domain, so the route borrows different scoped services per verb:
 *   - session list → `ISessionSkillCatalog` (Session scope) — `catalog.listSkills()`.
 *   - workspace list → no session: resolves `IWorkspaceService` (App scope)
 *     for the root, then composes the skill scan at the edge (see above).
 *   - activate     → `IAgentSkillService` (Agent scope, on the `main` agent) —
 *                    renders the skill prompt and starts a turn with a
 *                    `skill_activation` origin. The returned `Turn` handle is
 *                    discarded; clients follow progress via the `skill.activated`
 *                    + `turn.*` events emitted by the service on the WS stream.
 *                    The edge then applies the prompt-metadata update
 *                    (`applyPromptMetadataUpdate`) so a first `/<skill>`
 *                    message titles the session, matching the native RPC path.
 *
 * **Model projection**: `SkillDefinition` (v2) → protocol `SkillDescriptor`,
 * byte-for-byte with v1's `toProtocolSkill`
 * (`packages/agent-core/src/services/skill/skill.ts`): only
 * `name`/`description`/`path`/`source` plus optional `type` and
 * `disable_model_invocation` are emitted; `isSubSkill` is intentionally
 * dropped.
 *
 * **Error mapping**:
 *   - unknown workspace id          → envelope `code: 40410 workspace.not_found`.
 *   - not live / unknown session    → envelope `code: 40401 session.not_found` (see gate above).
 *   - `skill.not_found` / `skill.name_empty` → envelope `code: 40415 skill.not_found`.
 *   - `skill.type_unsupported`      → envelope `code: 40912 skill.not_activatable`.
 *   - malformed `{tail}` (bad action, bare)  → envelope `code: 40001 validation.failed`.
 *   - other errors → 50001 via the global `installErrorHandler`.
 *
 * **Action suffix**: the `:activate` POST endpoint uses the shared
 * `parseActionSuffix` helper (no bare form — `:activate` is the only action).
 *
 * **Anti-corruption**: route resolves every service via the accessor; no SDK
 * imports.
 */

import { join } from 'node:path';

import {
  BUILTIN_SKILLS,
  ErrorCodes,
  EXTRA_SKILL_DIRS_SECTION,
  IAgentSkillService,
  IBootstrapService,
  IConfigService,
  IEventService,
  IHostFileSystem,
  IPluginService,
  ISessionIndex,
  ISessionMetadata,
  ISessionSkillCatalog,
  ISkillDiscovery,
  IWorkspaceService,
  InMemorySkillCatalog,
  isError2,
  parseSkillText,
  resumeSessionById,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  SKILL_SOURCE_PRIORITY,
  applyPromptMetadataUpdate,
  configuredRoots,
  projectRoots,
  promptMetadataTextFromSkill,
  userRoots,
  type HostDirEntry,
  type ISessionScopeHandle,
  type Scope,
  type SkillDefinition,
  type ExtraSkillDirsConfig,
  type MergeAllAvailableSkillsConfig,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { ErrorCode } from '../protocol/error-codes';
import {
  activateSkillRequestSchema,
  activateSkillResultSchema,
  listSkillsResponseSchema,
} from '../protocol/rest-skill';
import {
  listUserSkillsResponseSchema,
  upsertUserSkillRequestSchema,
  userSkillDescriptorSchema,
  userSkillNameParamSchema,
  type WireUpsertUserSkillRequest,
  type WireUserSkill,
  type WireUserSkillNameParam,
} from '../protocol/rest-user-skill';
import { workspaceIdParamSchema } from '../protocol/rest-workspace';
import type { SkillDescriptor } from '../protocol/skill';
import { parseActionSuffix } from './action-suffix';

interface SkillsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const skillTailParamsSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

type ResolvedSession =
  | { readonly handle: ISessionScopeHandle }
  | { readonly envelope: ReturnType<typeof errEnvelope> };

/**
 * Resolve the session only when it is activated (live in the lifecycle map).
 * Otherwise build a `40401` envelope whose message distinguishes "not
 * activated" (persisted but not live) from "does not exist" (not persisted).
 */
async function resolveActivatedSession(
  core: Scope,
  sessionId: string,
  requestId: string,
): Promise<ResolvedSession> {
  // `resume` (not `get`) so listing/activating skills on a freshly-opened cold
  // session cold-loads it instead of reporting "not activated"; matches v1's
  // `resumeSession` in SkillService. `resume` returns undefined only when the
  // session is unknown or its workspace is gone.
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle !== undefined) return { handle };

  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  const msg =
    summary === undefined
      ? `session ${sessionId} does not exist`
      : `session ${sessionId} is not activated, you need to activate it first`;
  return { envelope: errEnvelope(ErrorCode.SESSION_NOT_FOUND, msg, requestId) };
}

export function registerSkillsRoutes(app: SkillsRouteHost, core: Scope): void {
  // GET /sessions/{session_id}/skills ------------------------------------
  const listSkillsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/skills',
      params: sessionIdParamSchema,
      success: { data: listSkillsResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List the skills available to a session',
      tags: ['skills'],
      operationId: 'listSkills',
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const resolved = await resolveActivatedSession(core, session_id, req.id);
      if ('envelope' in resolved) {
        reply.send(resolved.envelope);
        return;
      }
      const catalog = resolved.handle.accessor.get(ISessionSkillCatalog);
      await catalog.ready;
      const skills = catalog.catalog.listSkills().map(toProtocolSkill);
      reply.send(okEnvelope({ skills }, req.id));
    },
  );
  app.get(
    listSkillsRoute.path,
    listSkillsRoute.options,
    listSkillsRoute.handler as Parameters<SkillsRouteHost['get']>[2],
  );

  // GET /workspaces/{workspace_id}/skills ------------------------------
  const listWorkspaceSkillsRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/skills',
      params: workspaceIdParamSchema,
      success: { data: listSkillsResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List the skills available to a workspace (no session required)',
      tags: ['skills'],
      operationId: 'listWorkspaceSkills',
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const ws = await core.accessor.get(IWorkspaceService).get(workspace_id);
      if (ws === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      const skills = (await listWorkspaceSkillsForRoot(core, ws.root)).map(toProtocolSkill);
      reply.send(okEnvelope({ skills }, req.id));
    },
  );
  app.get(
    listWorkspaceSkillsRoute.path,
    listWorkspaceSkillsRoute.options,
    listWorkspaceSkillsRoute.handler as Parameters<SkillsRouteHost['get']>[2],
  );

  // POST /sessions/{session_id}/skills/{skill_name}:activate --------------
  const activateSkillRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/skills/{tail}',
      body: activateSkillRequestSchema,
      params: skillTailParamsSchema,
      success: { data: activateSkillResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SKILL_NOT_FOUND]: {},
        [ErrorCode.SKILL_NOT_ACTIVATABLE]: {},
      },
      description: 'Activate a skill in a session (REST analogue of the /<skill> slash command)',
      tags: ['skills'],
      operationId: 'activateSkill',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['activate'] as const,
        resourceLabel: 'skill_name',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      if (parsed.kind === 'bare') {
        // No bare form for /skills/{name} — only :activate.
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }

      const resolved = await resolveActivatedSession(core, session_id, req.id);
      if ('envelope' in resolved) {
        reply.send(resolved.envelope);
        return;
      }

      try {
        const agent = await ensureMainAgent(resolved.handle);
        await agent.accessor
          .get(IAgentSkillService)
          .activate({ name: parsed.id, args: req.body.args });
        // Keep the easy-title behavior of the native RPC / TUI path: a first
        // `/<skill>` message titles the session (same as routes/prompts.ts).
        await applyPromptMetadataUpdate(
          {
            metadata: resolved.handle.accessor.get(ISessionMetadata),
            eventService: core.accessor.get(IEventService),
            sessionId: session_id,
          },
          promptMetadataTextFromSkill({ name: parsed.id, args: req.body.args }),
        );
        requestLog(req)?.info({ session_id, skill_name: parsed.id }, 'skill activated');
        reply.send(okEnvelope({ activated: true, skill_name: parsed.id }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    activateSkillRoute.path,
    activateSkillRoute.options,
    activateSkillRoute.handler as Parameters<SkillsRouteHost['post']>[2],
  );

  // -------------------------------------------------------------------------
  // User-level SKILL.md management (config surface).
  //
  // Mirrors the `/mcp/config/servers` pattern: list/upsert/delete user-level
  // skills stored as `<kimi-home>/skills/<name>/SKILL.md`. Only the user-brand
  // directory is editable here — builtin/project/extra/plugin sources are
  // read-only from this surface. The skill `name` is constrained to
  // `/^[a-zA-Z0-9_-]+$/` (same as MCP server names) so it cannot escape the
  // `<kimi-home>/skills/<name>/` directory layout.
  // -------------------------------------------------------------------------

  const hostFs = core.accessor.get(IHostFileSystem);
  const userSkillsBootstrap = core.accessor.get(IBootstrapService);
  const userSkillsDir = join(userSkillsBootstrap.homeDir, 'skills');

  // GET /skills/config/user-skills ----------------------------------------
  const listUserSkillsRoute = defineRoute(
    {
      method: 'GET',
      path: '/skills/config/user-skills',
      success: { data: listUserSkillsResponseSchema },
      errors: {
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description: 'List user-level skills at <kimi-home>/skills/<name>/SKILL.md',
      tags: ['skills'],
      operationId: 'listUserSkills',
    },
    async (req, reply) => {
      const skills = await readUserSkills(hostFs, userSkillsDir, req.id, reply);
      if (skills === undefined) return; // error already sent
      reply.send(okEnvelope({ skills }, req.id));
    },
  );
  app.get(
    listUserSkillsRoute.path,
    listUserSkillsRoute.options,
    listUserSkillsRoute.handler as Parameters<SkillsRouteHost['get']>[2],
  );

  // POST /skills/config/user-skills/{name} --------------------------------
  const upsertUserSkillRoute = defineRoute(
    {
      method: 'POST',
      path: '/skills/config/user-skills/{name}',
      body: upsertUserSkillRequestSchema,
      params: userSkillNameParamSchema,
      success: { data: userSkillDescriptorSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description: 'Create or update a user-level skill (upsert)',
      tags: ['skills'],
      operationId: 'upsertUserSkill',
    },
    async (req, reply) => {
      const { name } = req.params as WireUserSkillNameParam;
      const { description, content } = req.body as WireUpsertUserSkillRequest;

      const skillDir = join(userSkillsDir, name);
      const skillMdPath = join(skillDir, 'SKILL.md');
      const fileText = serializeSkillMd(name, description, content);

      try {
        await hostFs.mkdir(skillDir, { recursive: true });
        await hostFs.writeText(skillMdPath, fileText);
      } catch (err) {
        reply.send(
          errEnvelope(
            ErrorCode.PERSISTENCE_FAILURE,
            `failed to write ${skillMdPath}: ${describeError(err)}`,
            req.id,
            err instanceof Error ? err.stack : undefined,
          ),
        );
        return;
      }
      requestLog(req)?.info({ name }, 'user skill upserted');
      reply.send(okEnvelope({ name, description, content }, req.id));
    },
  );
  app.post(
    upsertUserSkillRoute.path,
    upsertUserSkillRoute.options,
    upsertUserSkillRoute.handler as Parameters<SkillsRouteHost['post']>[2],
  );

  // DELETE /skills/config/user-skills/{name} ------------------------------
  const deleteUserSkillRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/skills/config/user-skills/{name}',
      params: userSkillNameParamSchema,
      success: { data: z.object({}).optional() },
      errors: {
        [ErrorCode.SKILL_NOT_FOUND]: {},
        [ErrorCode.PERSISTENCE_FAILURE]: {},
      },
      description: 'Remove a user-level skill directory',
      tags: ['skills'],
      operationId: 'deleteUserSkill',
    },
    async (req, reply) => {
      const { name } = req.params as WireUserSkillNameParam;
      const skillDir = join(userSkillsDir, name);
      const skillMdPath = join(skillDir, 'SKILL.md');

      // `hostFs.remove` uses `force: true` (no error on missing path), so
      // stat first to distinguish 40415 skill.not_found from a successful
      // delete of a pre-existing skill.
      try {
        await hostFs.stat(skillMdPath);
      } catch (err) {
        if (isError2(err) && err.code === ErrorCodes.OS_FS_NOT_FOUND) {
          reply.send(
            errEnvelope(ErrorCode.SKILL_NOT_FOUND, `skill ${name} does not exist`, req.id),
          );
          return;
        }
        reply.send(
          errEnvelope(
            ErrorCode.PERSISTENCE_FAILURE,
            `failed to stat ${skillMdPath}: ${describeError(err)}`,
            req.id,
            err instanceof Error ? err.stack : undefined,
          ),
        );
        return;
      }

      try {
        await hostFs.remove(skillDir);
      } catch (err) {
        reply.send(
          errEnvelope(
            ErrorCode.PERSISTENCE_FAILURE,
            `failed to remove ${skillDir}: ${describeError(err)}`,
            req.id,
            err instanceof Error ? err.stack : undefined,
          ),
        );
        return;
      }
      requestLog(req)?.info({ name }, 'user skill deleted');
      reply.send(okEnvelope({}, req.id));
    },
  );
  app.delete(
    deleteUserSkillRoute.path,
    deleteUserSkillRoute.options,
    deleteUserSkillRoute.handler as Parameters<SkillsRouteHost['delete']>[2],
  );
}

// ---------------------------------------------------------------------------
// Workspace skill scan — session-less composition of the four skill sources
// (see header). Mirrors `SessionSkillCatalogService`'s ordered merge so the
// listing matches a session created in the same cwd.
// ---------------------------------------------------------------------------

/**
 * Scan the skills a new session rooted at `workDir` would see, without creating
 * a session. Resolves the same five sources the per-session catalog merges —
 * builtin / user / extra / project(`workDir`) / plugin — through the shared
 * `ISkillDiscovery` and `skillRoots` primitives, then folds them into an
 * `InMemorySkillCatalog` by the documented source priorities (lower priority
 * first; `replace: true` lets higher-priority sources win name collisions). The
 * priority numbers come from `SKILL_SOURCE_PRIORITY`; the resulting name set is
 * priority-invariant, but matching them keeps descriptor resolution identical to
 * the session catalog.
 */
async function listWorkspaceSkillsForRoot(
  core: Scope,
  workDir: string,
): Promise<readonly SkillDefinition[]> {
  const discovery = core.accessor.get(ISkillDiscovery);
  const bootstrap = core.accessor.get(IBootstrapService);
  const plugins = core.accessor.get(IPluginService);
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const extraSkillDirs = config.get<ExtraSkillDirsConfig>(EXTRA_SKILL_DIRS_SECTION) ?? [];
  const mergeAllAvailableSkills =
    config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
  const explicitDirs = bootstrap.args.skillDirs ?? [];
  const useExplicitDirs = explicitDirs.length > 0;
  const rootOptions = { mergeAllAvailableSkills };

  const [userRootList, projectRootList, explicitRootList, extraRootList, pluginRootList] = await Promise.all([
    useExplicitDirs ? Promise.resolve([]) : userRoots(bootstrap.homeDir, bootstrap.osHomeDir, rootOptions),
    useExplicitDirs ? Promise.resolve([]) : projectRoots(workDir, rootOptions),
    useExplicitDirs
      ? configuredRoots(explicitDirs, workDir, bootstrap.osHomeDir, 'user')
      : Promise.resolve([]),
    configuredRoots(extraSkillDirs, workDir, bootstrap.osHomeDir, 'extra'),
    plugins.pluginSkillRoots(),
  ]);
  const [user, project, explicit, extra, plugin] = await Promise.all([
    discovery.discover(userRootList),
    discovery.discover(projectRootList),
    discovery.discover(explicitRootList),
    discovery.discover(extraRootList),
    discovery.discover(pluginRootList),
  ]);

  const catalog = new InMemorySkillCatalog();
  const ordered = [
    { skills: BUILTIN_SKILLS, priority: SKILL_SOURCE_PRIORITY.builtin },
    { skills: plugin.skills, priority: SKILL_SOURCE_PRIORITY.plugin },
    { skills: extra.skills, priority: SKILL_SOURCE_PRIORITY.extra },
    { skills: user.skills, priority: SKILL_SOURCE_PRIORITY.user },
    { skills: explicit.skills, priority: SKILL_SOURCE_PRIORITY.user },
    { skills: project.skills, priority: SKILL_SOURCE_PRIORITY.workspace },
  ].toSorted((a, b) => a.priority - b.priority);
  for (const { skills } of ordered) {
    for (const skill of skills) catalog.register(skill, { replace: true });
  }
  return catalog.listSkills();
}

// ---------------------------------------------------------------------------
// Projection — v2 `SkillDefinition` → protocol `SkillDescriptor` (see header).
// ---------------------------------------------------------------------------

type SkillElement = ReturnType<ISessionSkillCatalog['catalog']['listSkills']>[number];

function toProtocolSkill(skill: SkillElement): SkillDescriptor {
  const base: SkillDescriptor = {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: skill.source,
  };
  const type = skill.metadata.type;
  const disableModelInvocation = skill.metadata.disableModelInvocation;
  return {
    ...base,
    ...(type !== undefined ? { type } : {}),
    ...(disableModelInvocation !== undefined
      ? { disable_model_invocation: disableModelInvocation }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Error mapping (see header).
// ---------------------------------------------------------------------------

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.SKILL_NOT_FOUND:
      case ErrorCodes.SKILL_NAME_EMPTY:
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.SKILL_TYPE_UNSUPPORTED:
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_ACTIVATABLE, err.message, requestId, err.stack));
        return;
    }
  }
  throw err;
}

// ---------------------------------------------------------------------------
// User-level SKILL.md helpers (config surface — see route block above).
//
// `readUserSkills` scans `<skillsDir>/*/SKILL.md`, parses each via the shared
// `parseSkillText` (the same primitive `fileSkillDiscovery` uses), and skips
// malformed entries silently — the listing only returns valid skills. A
// missing `<skillsDir>` is treated as an empty list (no user skills yet).
//
// `serializeSkillMd` writes the canonical directory-form SKILL.md: frontmatter
// `name` + `description` (both required by `parseSkillText` for the directory
// form) followed by the markdown body. Values are JSON-quoted so any special
// characters (newlines, colons, quotes) survive the YAML round-trip.
// ---------------------------------------------------------------------------

async function readUserSkills(
  hostFs: IHostFileSystem,
  skillsDir: string,
  requestId: string,
  reply: { send(payload: unknown): unknown },
): Promise<readonly WireUserSkill[] | undefined> {
  let entries: readonly HostDirEntry[];
  try {
    entries = await hostFs.readdir(skillsDir);
  } catch (err) {
    if (isError2(err) && err.code === ErrorCodes.OS_FS_NOT_FOUND) {
      return []; // no user skills directory yet
    }
    reply.send(
      errEnvelope(
        ErrorCode.PERSISTENCE_FAILURE,
        `failed to read ${skillsDir}: ${describeError(err)}`,
        requestId,
        err instanceof Error ? err.stack : undefined,
      ),
    );
    return undefined;
  }

  const skills: WireUserSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
    let text: string;
    try {
      text = await hostFs.readText(skillMdPath);
    } catch (err) {
      // No SKILL.md in this subdir (or unreadable) — skip; the listing only
      // returns parseable directory-form skills.
      continue;
    }
    try {
      const parsed = parseSkillText({
        text,
        skillMdPath,
        skillDirName: entry.name,
        source: 'user',
      });
      skills.push({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
      });
    } catch {
      // Malformed SKILL.md — skip, matching fileSkillDiscovery's behavior.
      continue;
    }
  }
  return skills;
}

function serializeSkillMd(name: string, description: string, content: string): string {
  const frontmatter = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  return `${frontmatter}${content}\n`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
