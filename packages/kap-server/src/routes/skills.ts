import {
  builtinProductSkillsEnabled,
  visibleBuiltinSkills,
  Error2,
  ErrorCodes,
  EXTRA_SKILL_DIRS_SECTION,
  IAgentSkillService,
  IBootstrapService,
  IConfigService,
  IFileService,
  IPluginService,
  ISessionContext,
  ISessionIndex,
  ISessionMediaStore,
  ISessionSkillCatalog,
  ISkillDiscovery,
  ITelemetryService,
  IWorkspaceService,
  InMemorySkillCatalog,
  isError2,
  isUserActivatableSkillType,
  resumeSessionById,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  SKILL_SOURCE_PRIORITY,
  configuredRoots,
  projectRoots,
  sessionMediaOriginalsDir,
  userRoots,
  type ContentPart,
  type ISessionScopeHandle,
  type Scope,
  type SkillDefinition,
  type ExtraSkillDirsConfig,
  type MergeAllAvailableSkillsConfig,
} from '@moonshot-ai/agent-core-v2';
import { join } from 'node:path';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  assertPromptFileRefs,
  assertPromptSessionMediaRefs,
  contentToCoreParts,
  resolvePromptMediaFiles,
  type PromptMediaPreparation,
} from '../lib/promptMedia';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { ErrorCode } from '../protocol/error-codes';
import {
  activateSkillRequestSchema,
  activateSkillResultSchema,
  listSkillsResponseSchema,
} from '../protocol/rest-skill';
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

async function resolveActivatedSession(
  core: Scope,
  sessionId: string,
  requestId: string,
): Promise<ResolvedSession> {
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
        [ErrorCode.FILE_NOT_FOUND]: {},
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

      let preparedMedia: PromptMediaPreparation | undefined;
      try {
        const attachments = req.body.attachments ?? [];
        const attachmentParts: ContentPart[] = [];
        if (attachments.length > 0) {
          const catalog = resolved.handle.accessor.get(ISessionSkillCatalog);
          await catalog.ready;
          const skill = catalog.catalog.getSkill(parsed.id);
          if (skill === undefined) {
            throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${parsed.id}" was not found`);
          }
          if (!isUserActivatableSkillType(skill.metadata.type)) {
            throw new Error2(
              ErrorCodes.SKILL_TYPE_UNSUPPORTED,
              `Skill "${skill.name}" cannot be activated by the user`,
            );
          }
          await assertPromptFileRefs(attachments, core.accessor.get(IFileService));
          await assertPromptSessionMediaRefs(
            attachments,
            resolved.handle.accessor.get(ISessionMediaStore),
          );
          const telemetry = core.accessor.get(ITelemetryService).withContext({ sessionId: session_id });
          const sessionDir = resolved.handle.accessor.get(ISessionContext).sessionDir;
          preparedMedia = await resolvePromptMediaFiles(
            attachments,
            core.accessor.get(IFileService),
            core.accessor.get(IBootstrapService).cacheDir,
            {
              telemetry,
              resolveOriginalsDir: async () => sessionMediaOriginalsDir(sessionDir),
              resolveAttachmentsDir: async () => join(sessionDir, 'attachments'),
            },
          );
          attachmentParts.push(...contentToCoreParts(preparedMedia.content));
        }
        const agent = await ensureMainAgent(resolved.handle);
        await agent.accessor
          .get(IAgentSkillService)
          .activate({ name: parsed.id, args: req.body.args, content: attachmentParts });
        await preparedMedia?.discard();
        preparedMedia = undefined;
        requestLog(req)?.info({ session_id, skill_name: parsed.id }, 'skill activated');
        reply.send(okEnvelope({ activated: true, skill_name: parsed.id }, req.id));
      } catch (err) {
        await preparedMedia?.discard();
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
    {
      skills: visibleBuiltinSkills(builtinProductSkillsEnabled(config)),
      priority: SKILL_SOURCE_PRIORITY.builtin,
    },
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
      case ErrorCodes.FILE_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FILE_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.VALIDATION_FAILED:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
    }
  }
  throw err;
}
