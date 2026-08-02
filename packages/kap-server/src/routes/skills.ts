/**
 * `/skills` REST routes (session- and workspace-scoped) — engine-projected.
 *
 * Mirrors the v1 server's wire contract
 * (`packages/server/src/routes/skills.ts`) path-for-path and schema-for-schema:
 *
 *   GET  /sessions/{session_id}/skills                       data: {skills: SkillDescriptor[]}
 *   GET  /workspaces/{workspace_id}/skills                   data: {skills: SkillDescriptor[]}
 *
 * The session list is session-scoped: skills live in the engine session, so
 * the route projects the engine's `list_skills` RPC onto the v1 wire shape.
 * The workspace list (`/workspaces/{workspace_id}/skills`) is the session-less
 * counterpart: it scans the same roots a new session in that workspace cwd
 * would, so clients can populate the composer skill menu before a session
 * exists. The workspace id is resolved to its root via the host-owned
 * `WorkspaceRegistry` (`40410` when unknown); the root is then scanned for
 * project `.kimi-code/skills` + `.agents/skills` markdown — no engine catalog
 * (stage 3e).
 *
 * **Model projection**: `SkillDescriptor` is built from the engine's
 * `EngineSkillSummary` (`toEngineSkill`), byte-for-byte with v1's
 * `toProtocolSkill` (`packages/agent-core/src/services/skill/skill.ts`): only
 * `name`/`description`/`path`/`source` plus optional `type` are emitted;
 * `isSubSkill` is intentionally dropped. The `:activate` POST endpoint was
 * retired with the v2 `IAgentSkillService` — the engine owns skill
 * activation, there is no REST activation path in Rust mode.
 *
 * **Error mapping**:
 *   - unknown workspace id          → envelope `code: 40410 workspace.not_found`.
 *   - unknown session               → envelope `code: 40401 session.not_found`.
 *
 * **Anti-corruption**: route projects the engine session surface; no SDK
 * imports.
 */

import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { listSkillsResponseSchema } from '../protocol/rest-skill';
import { workspaceIdParamSchema } from '../protocol/rest-workspace';
import type { SkillDescriptor } from '../protocol/skill';
import type { EngineSkillSummary } from '@moonshot-ai/kimi-agent/rust-loop';
import type { RustSessionService } from '../services/rustSession/rustSessionService';
import type { WorkspaceRegistry } from '../services/workspaceRegistry';

interface SkillsRouteHost {
  get(
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

export function registerSkillsRoutes(
  app: SkillsRouteHost,
  rustSession: RustSessionService,
  registry?: WorkspaceRegistry,
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
      const { session_id } = req.params;
      // Engine mode: skills live in the engine session (per
      // session/list_skills); the retired v2 session lifecycle has no
      // knowledge of engine-owned sessions.
      const session = rustSession.getSession(session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} not found`,
            req.id,
          ),
        );
        return;
      }
      // Engine-mode skills: the engine session's registry plus the project
      // skills under the session workdir (the host-side scan mirrors what
      // `GET /workspaces/{wid}/skills` returns for the same root).
      const engineSkills =
        ((await rustSession.listSkills(session_id)) as
          | { skills: EngineSkillSummary[] }
          | null)?.skills?.map(toEngineSkill) ?? [];
      const projectSkills = await scanWorkspaceSkills(session.workDir);
      reply.send(okEnvelope({ skills: [...engineSkills, ...projectSkills] }, req.id));
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
      if (registry === undefined) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'workspace registry unavailable', req.id),
        );
        return;
      }
      // Host-owned workspace skill scan (stage 3e): project
      // `.kimi-code/skills` + `.agents/skills` markdown under the workspace
      // root, no engine catalog.
      const ws = await registry.get(workspace_id);
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
      const skills = await scanWorkspaceSkills(ws.root);
      reply.send(okEnvelope({ skills }, req.id));
    },
  );
  app.get(
    listWorkspaceSkillsRoute.path,
    listWorkspaceSkillsRoute.options,
    listWorkspaceSkillsRoute.handler as Parameters<SkillsRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// Projection — engine `EngineSkillSummary` → protocol `SkillDescriptor`.
// ---------------------------------------------------------------------------

/** Project an engine skill view onto the v1 `SkillDescriptor` wire shape.
 *  Engine `source` strings ('user'/'project'/'extra'/'plugin'/'builtin') map
 *  onto the v1 enum; anything unknown falls back to 'builtin'. */
function toEngineSkill(skill: EngineSkillSummary): SkillDescriptor {
  const base: SkillDescriptor = {
    name: skill.name,
    description: skill.description,
    path: skill.path ?? skill.dir ?? '',
    source: isSkillSource(skill.source) ? skill.source : 'builtin',
  };
  return {
    ...base,
    ...(skill.skill_type !== '' && skill.skill_type !== undefined
      ? { type: skill.skill_type }
      : {}),
  };
}

function isSkillSource(source: string | null | undefined): source is SkillDescriptor['source'] {
  return (
    source === 'project' || source === 'user' || source === 'extra' || source === 'builtin'
  );
}

/** Host-owned workspace skill scan (stage 3e): project `.kimi-code/skills` +
 *  `.agents/skills` markdown under the workspace root. Frontmatter
 *  `name`/`description` fall back to the file name. No engine catalog. */
async function scanWorkspaceSkills(workDir: string): Promise<SkillDescriptor[]> {
  const projectRoot = await findGitRoot(workDir);
  const dirs = [join(projectRoot, '.kimi-code', 'skills'), join(projectRoot, '.agents', 'skills')];
  const skills: SkillDescriptor[] = [];
  for (const dir of dirs) {
    const files = await collectSkillMarkdown(dir);
    for (const fullPath of files) {
      const { name, description } = await readSkillFrontmatter(fullPath, basename(fullPath));
      skills.push({ name, description, path: fullPath, source: 'project' });
    }
  }
  return skills;
}

/** Recursively collect `.md` files under a skills directory, including
 *  `<name>/SKILL.md` nested layouts (project skills ship as one dir per
 *  skill). Returns absolute paths sorted depth-first. */
async function collectSkillMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSkillMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

async function findGitRoot(workDir: string): Promise<string> {
  let current = resolve(workDir);
  while (true) {
    if (await stat(join(current, '.git')).then((s) => s.isDirectory()).catch(() => false)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(workDir);
    current = parent;
  }
}

async function readSkillFrontmatter(
  filePath: string,
  fallbackName: string,
): Promise<{ name: string; description: string }> {
  try {
    const text = await readFile(filePath, 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (match !== null) {
      const body = match[1] ?? '';
      const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim();
      const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim();
      return {
        name: name ?? fallbackName.replace(/\.md$/, ''),
        description: description ?? '',
      };
    }
  } catch {
    // unreadable file — fall through to the file-name default
  }
  return { name: fallbackName.replace(/\.md$/, ''), description: '' };
}
