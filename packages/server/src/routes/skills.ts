/**
 * `/sessions/{session_id}/skills*` REST routes.
 *
 * 2 endpoints:
 *
 *   GET  /sessions/{session_id}/skills                       data: {skills: SkillDescriptor[]}
 *   POST /sessions/{session_id}/skills/{skill_name}:activate body: {args?}  data: {activated: true, skill_name}
 *
 * Skills are session-scoped: the registry is built per session (project
 * skills are discovered from the session cwd), so the list lives under
 * `/sessions/{session_id}` rather than as a global collection like `/tools`.
 *
 * Activation is the REST analogue of typing `/<skill> <args>` in the TUI: it
 * renders the skill prompt and starts a turn on the session's main agent with
 * a `skill_activation` origin. No prompt_id is minted (the turn bypasses
 * `IPromptService`); clients follow progress via `skill.activated` and
 * `turn.*` events on the WS stream.
 *
 * **Error mapping**:
 *   - `SessionNotFoundError`      → envelope `code: 40401 session.not_found`.
 *   - `SkillNotFoundError`        → envelope `code: 40415 skill.not_found`.
 *   - `SkillNotActivatableError`  → envelope `code: 40912 skill.not_activatable`.
 *   - Other errors → 50001 via the global `installErrorHandler`.
 *
 * **Action suffix**: the `:activate` POST endpoint uses the shared
 * `parseActionSuffix` helper (no bare form — `:activate` is the only action).
 *
 * **Anti-corruption**: route resolves `ISkillService` via the accessor; no
 * SDK imports.
 */

import {
  ErrorCode,
  activateSkillRequestSchema,
  activateSkillResultSchema,
  listSkillsResponseSchema,
} from '@moonshot-ai/protocol';
import { ISkillService, SessionNotFoundError, SkillNotActivatableError, SkillNotFoundError, type IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
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

export function registerSkillsRoutes(
  app: SkillsRouteHost,
  ix: IInstantiationService,
): void {
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
      try {
        const { session_id } = req.params;
        const skills = await ix.invokeFunction((a) =>
          a.get(ISkillService).list(session_id),
        );
        reply.send(okEnvelope({ skills }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
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
      params: sessionIdParamSchema.extend({ tail: z.string().min(1) }),
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
      try {
        const { session_id, tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['activate'] as const,
          resourceLabel: 'skill_name',
        });
        if (parsed.kind === 'invalid') {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
          );
          return;
        }
        if (parsed.kind === 'bare') {
          // No bare form for /skills/{name} — only :activate.
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `unsupported action: ${tail}`,
              req.id,
            ),
          );
          return;
        }
        await ix.invokeFunction((a) =>
          a.get(ISkillService).activate(session_id, parsed.id, req.body.args),
        );
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

/**
 * Map a thrown error to the right envelope. See module header for the table.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof SkillNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SKILL_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof SkillNotActivatableError) {
    reply.send(errEnvelope(ErrorCode.SKILL_NOT_ACTIVATABLE, err.message, requestId));
    return;
  }
  throw err;
}
