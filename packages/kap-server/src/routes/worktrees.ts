import { IWorkspaceService, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { workspaceIdParamSchema } from '../protocol/rest-workspace';
import {
  inspectWorktreesRequestSchema,
  inspectWorktreesResponseSchema,
  listWorktreesQuerySchema,
  listWorktreesResponseSchema,
  lookupWorktreeRequestSchema,
  lookupWorktreeResponseSchema,
  removeWorktreeRequestSchema,
  removeWorktreeResponseSchema,
  sessionWorktreeActionSchema,
  sessionWorktreeRetryRequestSchema,
  workspaceGitBranchesResponseSchema,
  worktreeRemoveFailedDetailsSchema,
  type SessionWorktreeAction,
} from '../protocol/rest-worktree';
import { sessionSchema } from '../protocol/session';
import { isDirty, isRepoRoot, listLocalBranches } from '../services/worktrees/gitRefs';
import type { SessionWorktreeService } from '../services/worktrees/sessionWorktreeService';
import { WorktreeError } from '../services/worktrees/worktreeError';
import { sendMappedError as sendSessionMappedError, sessionConflictErrors } from './sessionErrors';
import { readWireSession } from './sessions';
import { toWireWorkspace } from './workspaces';

interface WorktreeRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
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

const sessionIdParamSchema = z.object({ session_id: z.string().min(1) });

const optionalBody = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value ?? {}, schema);

const SESSION_WORKTREE_ACTION_DESCRIPTIONS: Readonly<Record<SessionWorktreeAction, string>> = {
  retry: 'Start a fresh worktree setup after a failed or stopped one; the body may override use_remote and include_local_changes',
  cancel: 'Stop the running worktree setup and remove what it created',
  use_local: 'Give up the worktree and keep working in the workspace root',
  skip_script: 'Skip the setup script and mark the worktree ready',
  run_script: 'Run (or confirm and run) the setup script again without recreating the worktree',
  recreate: 'Recreate a missing worktree directory from its recorded branch',
};

function sendWorktreeError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  error: unknown,
): void {
  if (error instanceof WorktreeError) {
    reply.send(errEnvelope(error.code, error.message, req.id, error.details));
    return;
  }
  sendSessionMappedError(reply, req, error);
}

export function registerWorktreeRoutes(
  app: WorktreeRouteHost,
  core: Scope,
  worktrees: SessionWorktreeService,
): void {
  for (const action of sessionWorktreeActionSchema.options) {
    const actionRoute = defineRoute(
      {
        method: 'POST',
        path: `/sessions/{session_id}/worktree::${action}`,
        params: sessionIdParamSchema,
        body: optionalBody(action === 'retry' ? sessionWorktreeRetryRequestSchema : z.object({})),
        success: { data: sessionSchema },
        errors: {
          [ErrorCode.VALIDATION_FAILED]: {},
          [ErrorCode.SESSION_NOT_FOUND]: {},
          [ErrorCode.SESSION_BUSY]: {},
          [ErrorCode.WORKSPACE_NOT_FOUND]: {},
          [ErrorCode.WORKTREE_STATE_INVALID]: {},
          [ErrorCode.WORKTREE_UNSUPPORTED]: {},
          ...sessionConflictErrors,
        },
        description: `${SESSION_WORKTREE_ACTION_DESCRIPTIONS[action]}. Returns the updated session`,
        tags: ['worktrees'],
        operationId: `runSessionWorktree${action.replaceAll(/(^|_)([a-z])/g, (_match, _sep, letter: string) => letter.toUpperCase())}Action`,
      },
      async (req, reply) => {
        const { session_id } = req.params;
        try {
          await worktrees.act(session_id, action, req.body);
          const session = await readWireSession(core, worktrees, session_id);
          if (session === undefined) {
            reply.send(
              errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
            );
            return;
          }
          requestLog(req)?.info({ session_id, action: `worktree:${action}` }, 'session action completed');
          reply.send(okEnvelope(session, req.id));
        } catch (error) {
          sendWorktreeError(reply, req, error);
        }
      },
    );
    app.post(
      actionRoute.path,
      actionRoute.options,
      actionRoute.handler as Parameters<WorktreeRouteHost['post']>[2],
    );
  }

  const branchesRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/git/branches',
      params: workspaceIdParamSchema,
      success: { data: workspaceGitBranchesResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description:
        'List the local branches of the workspace root, newest commit first, each with the remote branch a worktree would fetch. Never touches the network; is_repo is false when the root is not the root of a git repository',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      const workspace = await core.accessor.get(IWorkspaceService).get(req.params.workspace_id);
      if (workspace === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${req.params.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
      if (!(await isRepoRoot(workspace.root))) {
        reply.send(okEnvelope({ is_repo: false, dirty: false, branches: [] }, req.id));
        return;
      }
      const [listed, dirty] = await Promise.all([
        listLocalBranches(workspace.root),
        isDirty(workspace.root),
      ]);
      reply.send(
        okEnvelope(
          {
            is_repo: true,
            head_branch: listed.headBranch,
            dirty,
            branches: listed.branches.map((branch) => ({
              name: branch.name,
              committed_at: branch.committedAt,
              remote_ref: branch.remote?.ref,
            })),
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    branchesRoute.path,
    branchesRoute.options,
    branchesRoute.handler as Parameters<WorktreeRouteHost['get']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/worktrees',
      querystring: listWorktreesQuerySchema,
      success: { data: listWorktreesResponseSchema },
      description:
        'List the linked git worktrees of every registered workspace: the ones created for sessions (origin "product") and any other (origin "external"), each with the sessions working in it. size_bytes is computed in the background and omitted until known; refresh=sizes recomputes every size before answering',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await worktrees.inventory.list(req.query.refresh === 'sizes'), req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<WorktreeRouteHost['get']>[2],
  );

  const inspectRoute = defineRoute(
    {
      method: 'POST',
      path: '/worktrees::inspect',
      body: inspectWorktreesRequestSchema,
      success: { data: inspectWorktreesResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description:
        'Report what removing each worktree would lose: uncommitted files and commits that are on no remote, plus the sessions working in it. Paths that are not known worktrees fold into errors',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await worktrees.inventory.inspect(req.body.paths), req.id));
    },
  );
  app.post(
    inspectRoute.path,
    inspectRoute.options,
    inspectRoute.handler as Parameters<WorktreeRouteHost['post']>[2],
  );

  const removeRoute = defineRoute(
    {
      method: 'POST',
      path: '/worktrees::remove',
      body: removeWorktreeRequestSchema,
      success: { data: removeWorktreeResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.WORKTREE_NOT_FOUND]: {},
        [ErrorCode.WORKTREE_REMOVE_FAILED]: { detailsSchema: worktreeRemoveFailedDetailsSchema },
      },
      description:
        'Remove a worktree directory and its git registration, even with uncommitted changes, and optionally its local branch. Refused while a session that uses it is running; sessions that used it then report worktree.missing',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      try {
        const removed = await worktrees.inventory.remove(req.body.path, req.body.delete_branch === true);
        requestLog(req)?.info({ path: req.body.path, action: 'worktree:remove' }, 'worktree removed');
        reply.send(okEnvelope(removed, req.id));
      } catch (error) {
        sendWorktreeError(reply, req, error);
      }
    },
  );
  app.post(
    removeRoute.path,
    removeRoute.options,
    removeRoute.handler as Parameters<WorktreeRouteHost['post']>[2],
  );

  const lookupRoute = defineRoute(
    {
      method: 'POST',
      path: '/worktrees::lookup',
      body: lookupWorktreeRequestSchema,
      success: { data: lookupWorktreeResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description:
        'Tell whether a directory is a linked git worktree, and of which repository, branch and registered workspace. worktree is null for anything else',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      const found = await worktrees.inventory.lookup(req.body.path);
      reply.send(
        okEnvelope(
          {
            worktree:
              found === undefined
                ? null
                : {
                    repo_root: found.repoRoot,
                    branch: found.branch,
                    workspace:
                      found.workspace === undefined
                        ? undefined
                        : await toWireWorkspace(core, found.workspace),
                    session_count: found.sessionCount,
                  },
          },
          req.id,
        ),
      );
    },
  );
  app.post(
    lookupRoute.path,
    lookupRoute.options,
    lookupRoute.handler as Parameters<WorktreeRouteHost['post']>[2],
  );
}
