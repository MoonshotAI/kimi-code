/**
 * Skills end-to-end tests.
 *
 * Coverage:
 *   - GET  /api/v1/sessions/{sid}/skills                → envelope shape + skills[]
 *                                                         (project skill discovered from session cwd)
 *   - GET  /api/v1/sessions/unknown/skills              → 40401 session.not_found
 *   - POST /api/v1/sessions/{sid}/skills/{name}:activate
 *       · inline project skill                          → {activated:true, skill_name}
 *       · unknown skill                                 → 40415 skill.not_found
 *       · reference-type skill                          → 40912 skill.not_activatable
 *       · unknown session                               → 40401
 *   - POST /api/v1/sessions/{sid}/skills/foo:bogus      → 40001 unsupported action
 *   - POST /api/v1/sessions/{sid}/skills/foo (bare)     → 40001
 *
 * **Bootstrap strategy**: same as tools.e2e — spawn the real server with a
 * sandboxed HOME. Project skills are seeded under
 * `<cwd>/.kimi-code/skills/<name>/SKILL.md` BEFORE the session is created,
 * because the registry scans skill roots at session construction.
 *
 * **Activation success**: `TurnFlow.prompt` enqueues asynchronously, so the
 * activate RPC resolves even though the sandboxed daemon has no model
 * configured — the turn fails later via an async `error` event, which is out
 * of scope here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import {
  activateSkillResultSchema,
  listSkillsResponseSchema,
} from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspaceDir: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-skills-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-skills-home-'));
  workspaceDir = join(tmpDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  // The daemon's core process may still flush files into the sandboxed home
  // briefly after close(), so retry removals to ride out EBUSY/ENOTEMPTY races.
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  rmSync(bridgeHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: workspaceDir } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

/** Seed a project skill bundle at `<cwd>/.kimi-code/skills/<name>/SKILL.md`. */
function seedProjectSkill(name: string, frontmatterType?: string): void {
  const dir = join(workspaceDir, '.kimi-code', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const typeLine = frontmatterType === undefined ? '' : `type: ${frontmatterType}\n`;
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: e2e test skill ${name}\n${typeLine}---\n\nSay hello to $ARGUMENTS.\n`,
  );
}

describe('GET /api/v1/sessions/{sid}/skills', () => {
  it('lists skills including a project skill seeded in the session cwd', async () => {
    seedProjectSkill('e2e-greeting');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/skills`,
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const parsed = listSkillsResponseSchema.parse(env.data);
    const seeded = parsed.skills.find((s) => s.name === 'e2e-greeting');
    expect(seeded).toBeDefined();
    expect(seeded?.source).toBe('project');
    expect(seeded?.description).toBe('e2e test skill e2e-greeting');
  });

  it('returns 40401 for an unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'GET',
      url: '/api/v1/sessions/does-not-exist/skills',
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });
});

describe('POST /api/v1/sessions/{sid}/skills/{name}:activate', () => {
  it('activates an inline project skill and returns {activated:true}', async () => {
    seedProjectSkill('e2e-greeting');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/skills/e2e-greeting:activate`,
      payload: { args: 'world' },
    });
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
    const parsed = activateSkillResultSchema.parse(env.data);
    expect(parsed.skill_name).toBe('e2e-greeting');
  });

  it('accepts an empty body (args optional)', async () => {
    seedProjectSkill('e2e-greeting');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/skills/e2e-greeting:activate`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(0);
  });

  it('returns 40415 skill.not_found for an unknown skill', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/skills/no-such-skill:activate`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40415);
  });

  it('returns 40912 skill.not_activatable for a reference-type skill', async () => {
    seedProjectSkill('e2e-reference', 'reference');
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/skills/e2e-reference:activate`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40912);
  });

  it('returns 40401 for an unknown session', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/does-not-exist/skills/foo:activate',
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });

  it('rejects unsupported action with 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/skills/foo:bogus`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(env.msg).toMatch(/unsupported action/);
  });

  it('rejects bare {name} (no action) with 40001 — :activate is the only allowed action', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/skills/foo`,
      payload: {},
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});
