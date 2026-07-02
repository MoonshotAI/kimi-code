/**
 * `/sessions/{session_id}/skills*` REST routes — server-v2 port.
 *
 * Mirrors the v1 server's wire contract
 * (`packages/server/src/routes/skills.ts`) path-for-path and schema-for-schema:
 *
 *   GET  /sessions/{session_id}/skills                       data: {skills: SkillDescriptor[]}
 *   POST /sessions/{session_id}/skills/{skill_name}:activate body: {args?}  data: {activated: true, skill_name}
 *
 * **Activation gate**: by convention these endpoints are only valid for an
 * *activated* session — one that is live in `ISessionLifecycleService`. When
 * the session is not in the live map we still answer `40401 session.not_found`
 * (the only session error code on the v1 wire contract), but we enrich the
 * message:
 *   - persisted in `ISessionIndex` but not live → `"... is not activated, you need to activate it first"`;
 *   - not in the index at all                  → `"... does not exist"`.
 *
 * **Scope split**: v1 resolves a single `ISkillService` for both verbs. v2
 * splits the domain, so the route borrows two scoped services:
 *   - list     → `ISessionSkillCatalog` (Session scope) — `catalog.listSkills()`.
 *   - activate → `IAgentSkillService` (Agent scope, on the `main` agent) —
 *                renders the skill prompt and starts a turn with a
 *                `skill_activation` origin. The returned `Turn` handle is
 *                discarded; clients follow progress via the `skill.activated`
 *                + `turn.*` events emitted by the service on the WS stream.
 *
 * **Model projection**: `SkillDefinition` (v2) → protocol `SkillDescriptor`,
 * byte-for-byte with v1's `toProtocolSkill`
 * (`packages/agent-core/src/services/skill/skill.ts`): only
 * `name`/`description`/`path`/`source` plus optional `type` and
 * `disable_model_invocation` are emitted; `isSubSkill` is intentionally
 * dropped.
 *
 * **Error mapping**:
 *   - not live / unknown session → envelope `code: 40401 session.not_found` (see gate above).
 *   - `skill.not_found` / `skill.name_empty` → envelope `code: 40415 skill.not_found`.
 *   - `skill.type_unsupported`               → envelope `code: 40912 skill.not_activatable`.
 *   - malformed `{tail}` (bad action, bare)  → envelope `code: 40001 validation.failed`.
 *   - other errors → 50001 via the global `installErrorHandler`.
 *
 * **Action suffix**: the `:activate` POST endpoint uses the shared
 * `parseActionSuffix` helper (no bare form — `:activate` is the only action).
 *
 * **Anti-corruption**: route resolves `ISessionSkillCatalog` / `IAgentSkillService`
 * via the accessor; no SDK imports.
 */

import {
  ErrorCodes,
  IAgentSkillService,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionSkillCatalog,
  isKimiError,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  activateSkillRequestSchema,
  activateSkillResultSchema,
  listSkillsResponseSchema,
  type SkillDescriptor,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
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
  const handle = core.accessor.get(ISessionLifecycleService).get(sessionId);
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
  if (isKimiError(err)) {
    switch (err.code) {
      case ErrorCodes.SKILL_NOT_FOUND:
      case ErrorCodes.SKILL_NAME_EMPTY:
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_FOUND, err.message, requestId));
        return;
      case ErrorCodes.SKILL_TYPE_UNSUPPORTED:
        reply.send(errEnvelope(ErrorCode.SKILL_NOT_ACTIVATABLE, err.message, requestId));
        return;
    }
  }
  throw err;
}
