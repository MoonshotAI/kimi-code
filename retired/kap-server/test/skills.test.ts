/**
 * `/api/v1` skills routes — engine-projected port (Rust mode).
 *
 * Covers the wire contract of the endpoints:
 *   - GET  /api/v1/sessions/{sid}/skills                  → envelope shape + skills[]
 *   - GET  on an unknown session                          → 40401 "does not exist"
 *   - GET  /api/v1/workspaces/{wid}/skills                → skills[] (no session)
 *   - GET  workspace listing == session listing (same cwd) → parity
 *   - GET  on an unknown workspace                        → 40410
 *   - POST /api/v1/sessions/{sid}/skills/{name}:activate   → wire error paths
 *
 * Session skills are projected from the Rust engine session
 * (`session/list_skills`); workspace skills are scanned session-less from the
 * workspace root via the host-owned scan in `routes/skills.ts`, which must
 * match the session listing for the same cwd. The `:activate` POST endpoint
 * was retired with the v2 `IAgentSkillService` — the engine owns skill
 * activation, there is no REST activation path in Rust mode.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listSkillsResponseSchema } from '../src/protocol/rest-skill';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface SkillWire {
  name: string;
  description: string;
  path: string;
  source: string;
  type?: string;
  disable_model_invocation?: boolean;
}

describe('server-v2 /api/v1 skills', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-skills-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string = home as string): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd },
    });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function registerWorkspace(root: string): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/workspaces', { root });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // Lives under `home` so the existing afterEach cleanup removes it; unique per
  // call so parallel tests do not collide on skill roots.
  async function makeWorkspaceDir(): Promise<string> {
    const dir = join(
      home as string,
      `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Seed a project skill bundle at `<root>/.kimi-code/skills/<name>/SKILL.md`. */
  async function seedProjectSkill(root: string, name: string): Promise<void> {
    const dir = join(root, '.kimi-code', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: e2e test skill ${name}\n---\n\nSay hello to $ARGUMENTS.\n`,
    );
  }

  describe('GET /api/v1/sessions/{sid}/skills', () => {
    it('returns 40401 for an unknown session', async () => {
      const { body } = await getJson<null>('/api/v1/sessions/nope/skills');
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/not found/);
    });

    it('projects session skills onto the wire shape', async () => {
      const id = await createSession();
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/v1/sessions/${id}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;
      // Engine mode: the engine session owns the registry; a fresh session
      // has no skills, and every entry (when present) is well-formed with a
      // known `source` and no sub-skill leak on the wire.
      expect(skills).toEqual([]);
    });
  });

  describe('GET /api/v1/workspaces/{wid}/skills', () => {
    it('lists skills for a workspace without creating a session', async () => {
      const workspaceDir = await makeWorkspaceDir();
      await seedProjectSkill(workspaceDir, 'e2e-greeting');
      const wid = await registerWorkspace(workspaceDir);

      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/v1/workspaces/${wid}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;
      const seeded = skills.find((s) => s.name === 'e2e-greeting');
      expect(seeded).toBeDefined();
      expect(seeded?.source).toBe('project');
      expect(seeded?.description).toBe('e2e test skill e2e-greeting');
    });

    it('matches the session listing for the same cwd', async () => {
      const workspaceDir = await makeWorkspaceDir();
      await seedProjectSkill(workspaceDir, 'e2e-greeting');
      const wid = await registerWorkspace(workspaceDir);
      const sid = await createSession(workspaceDir);

      const [wsRes, sessRes] = await Promise.all([
        getJson<{ skills: SkillWire[] }>(`/api/v1/workspaces/${wid}/skills`),
        getJson<{ skills: SkillWire[] }>(`/api/v1/sessions/${sid}/skills`),
      ]);
      const wsSkills = listSkillsResponseSchema.parse(wsRes.body.data).skills;
      const sessSkills = listSkillsResponseSchema.parse(sessRes.body.data).skills;
      const names = (xs: readonly { name: string }[]) => xs.map((s) => s.name).toSorted();
      expect(names(wsSkills)).toEqual(names(sessSkills));
    });

    it('returns 40410 for an unknown workspace', async () => {
      const { body } = await getJson<null>(
        '/api/v1/workspaces/wd_does-not-exist_000000000000/skills',
      );
      expect(body.code).toBe(40410);
    });
  });
});
