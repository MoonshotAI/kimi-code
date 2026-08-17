import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import {
  activateSkillResultSchema,
  listSkillsResponseSchema,
} from '../src/protocol/rest-skill';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
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
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
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

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const agents = session.accessor.get(IAgentLifecycleService);
    if (agents.get('main') === undefined) await agents.create({ agentId: 'main' });
  }

  async function registerWorkspace(root: string): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/workspaces', { root });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function makeWorkspaceDir(): Promise<string> {
    const dir = join(
      home as string,
      `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function seedProjectSkill(root: string, name: string): Promise<void> {
    const dir = join(root, '.kimi-code', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: e2e test skill ${name}\n---\n\nSay hello to $ARGUMENTS.\n`,
    );
  }

  async function seedExplicitSkill(root: string, name: string): Promise<void> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: explicit skill ${name}\n---\n\nSay hello to $ARGUMENTS.\n`,
    );
  }

  describe('GET /api/v1/sessions/{sid}/skills', () => {
    it('returns 40401 for an unknown session', async () => {
      const { body } = await getJson<null>('/api/v1/sessions/nope/skills');
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/does not exist/);
    });

    it('cold-loads a persisted but not live (archived) session and lists skills', async () => {
      const id = await createSession();
      const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
      expect(archived.body.code).toBe(0);

      const { body } = await getJson<{ skills: SkillWire[] }>(`/api/v1/sessions/${id}/skills`);
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;
      expect(skills.some((s) => s.name === 'update-config')).toBe(true);
    });

    it('lists builtin skills projected to the wire shape', async () => {
      const id = await createSession();
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/v1/sessions/${id}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;

      const updateConfig = skills.find((s) => s.name === 'update-config');
      expect(updateConfig).toBeDefined();
      expect(updateConfig).toMatchObject({ source: 'builtin' });
      expect(updateConfig).not.toHaveProperty('is_sub_skill');
      expect(updateConfig).not.toHaveProperty('isSubSkill');
    });

    it('lists the check-kimi-code-docs builtin skill', async () => {
      const id = await createSession();
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/v1/sessions/${id}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;

      const docsSkill = skills.find((s) => s.name === 'check-kimi-code-docs');
      expect(docsSkill).toBeDefined();
      expect(docsSkill).toMatchObject({ source: 'builtin' });
      expect(docsSkill?.description.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/v1/sessions/{sid}/skills/{name}:activate', () => {
    it('activates a builtin skill and returns the wire envelope', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/v1/sessions/${id}/skills/update-config:activate`,
        { args: '--help' },
      );
      expect(body.code).toBe(0);
      expect(activateSkillResultSchema.parse(body.data)).toEqual({
        activated: true,
        skill_name: 'update-config',
      });
    });

    it('derives the session title from the first skill activation', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const activated = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/v1/sessions/${id}/skills/update-config:activate`,
        { args: '--help' },
      );
      expect(activated.body.code).toBe(0);

      const got = await getJson<{ title: string }>(`/api/v1/sessions/${id}`);
      expect(got.body.code).toBe(0);
      expect(got.body.data.title).toBe('/update-config --help');
    });

    it('returns 40415 for an unknown skill', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<null>(
        `/api/v1/sessions/${id}/skills/does-not-exist:activate`,
      );
      expect(body.code).toBe(40415);
    });

    it('returns 40401 for an unknown session', async () => {
      const { body } = await postJson<null>('/api/v1/sessions/nope/skills/update-config:activate');
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/does not exist/);
    });

    it('rejects a bare {name} (no action) with 40001', async () => {
      const id = await createSession();
      const { body } = await postJson<null>(`/api/v1/sessions/${id}/skills/update-config`);
      expect(body.code).toBe(40001);
      expect(body.msg).toMatch(/unsupported action/);
    });

    it('rejects an unsupported action with 40001', async () => {
      const id = await createSession();
      const { body } = await postJson<null>(
        `/api/v1/sessions/${id}/skills/update-config:bogus`,
      );
      expect(body.code).toBe(40001);
      expect(body.msg).toMatch(/unsupported action/);
    });

    it('carries a file attachment into the activation message', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const noteBytes = Buffer.from('hello from the attachment');
      const form = new FormData();
      form.set('file', new Blob([noteBytes], { type: 'text/plain' }), 'note.txt');
      const uploadRes = await fetch(`${base}/api/v1/files`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer),
        body: form,
      } as never);
      const uploaded = (await uploadRes.json()) as Envelope<{ id: string; size: number }>;
      expect(uploaded.code).toBe(0);

      const { body } = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/v1/sessions/${id}/skills/update-config:activate`,
        {
          args: '--help',
          attachments: [
            {
              type: 'file',
              file_id: uploaded.data.id,
              name: 'note.txt',
              media_type: 'text/plain',
              size: noteBytes.length,
            },
          ],
        },
      );
      expect(body.code).toBe(0);
      expect(body.data).toEqual({ activated: true, skill_name: 'update-config' });

      const messages = await getJson<{
        items: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      }>(`/api/v1/sessions/${id}/messages`);
      const userMsg = messages.body.data.items.find((m) => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg!.content[0]?.type).toBe('text');
      expect(userMsg!.content[0]?.text).toContain('User activated the skill "update-config"');
      const notice = userMsg!.content[1];
      expect(notice?.type).toBe('text');
      expect(notice?.text).toContain('Attached file "note.txt"');
      expect(notice?.text).toContain(`${noteBytes.length} bytes`);
      const attachedPath = /bytes\): (.+) — open it with the Read tool$/.exec(notice?.text ?? '')?.[1];
      expect(attachedPath).toBeDefined();
      expect(attachedPath).toContain('/attachments/');
      expect(await readFile(attachedPath!)).toEqual(noteBytes);
    });

    it('rejects an activation with a stale attachment file_id (40407)', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<null>(
        `/api/v1/sessions/${id}/skills/update-config:activate`,
        {
          attachments: [
            { type: 'file', file_id: 'f_does_not_exist', name: 'x.txt', media_type: 'text/plain', size: 1 },
          ],
        },
      );
      expect(body.code).toBe(40407);
    });

    it('rejects an unknown skill with attachments before materializing them (40415)', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const noteBytes = Buffer.from('must never be materialized');
      const form = new FormData();
      form.set('file', new Blob([noteBytes], { type: 'text/plain' }), 'note.txt');
      const uploadRes = await fetch(`${base}/api/v1/files`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer),
        body: form,
      } as never);
      const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
      expect(uploaded.code).toBe(0);

      const { body } = await postJson<null>(
        `/api/v1/sessions/${id}/skills/does-not-exist:activate`,
        {
          attachments: [
            { type: 'file', file_id: uploaded.data.id, name: 'note.txt', media_type: 'text/plain', size: noteBytes.length },
          ],
        },
      );
      expect(body.code).toBe(40415);

      const sessionTree = await readdir(join(home as string, 'sessions'), { recursive: true });
      expect(sessionTree.filter((entry) => entry.includes('attachments'))).toEqual([]);
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

    it('honors explicit skill dirs in workspace preview', async () => {
      const workspaceDir = await makeWorkspaceDir();
      await seedProjectSkill(workspaceDir, 'e2e-explicit');
      const explicitDir = await makeWorkspaceDir();
      await seedExplicitSkill(explicitDir, 'e2e-explicit');

      await server!.close();
      server = undefined;
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        skillDirs: [explicitDir],
      });
      base = `http://127.0.0.1:${server.port}`;

      const wid = await registerWorkspace(workspaceDir);
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/v1/workspaces/${wid}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;
      const seeded = skills.find((s) => s.name === 'e2e-explicit');
      expect(seeded).toBeDefined();
      expect(seeded?.source).toBe('user');
      expect(seeded?.description).toBe('explicit skill e2e-explicit');
    });

    it('returns 40410 for an unknown workspace', async () => {
      const { body } = await getJson<null>(
        '/api/v1/workspaces/wd_does-not-exist_000000000000/skills',
      );
      expect(body.code).toBe(40410);
    });
  });
});
