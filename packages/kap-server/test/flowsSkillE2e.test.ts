import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const FLOW_ENV = 'KIMI_CODE_EXPERIMENTAL_FLOW';

const DEF = `---
id: issue-fix
when: bugs
stages:
  - id: triage
    objective: find it
    completion: found
---
`;

describe('flows skill source e2e', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeEach(async () => {
    process.env[FLOW_ENV] = 'true';
    home = await mkdtemp(join(tmpdir(), 'kimi-flows-e2e-'));
    await mkdir(join(home, '.kimi-code', 'flows'), { recursive: true });
    await writeFile(join(home, '.kimi-code', 'flows', 'issue-fix.md'), DEF);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  afterEach(async () => {
    delete process.env[FLOW_ENV];
    if (server) await server.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('lists the flow definition as a flow-typed skill', async () => {
    const base = `http://127.0.0.1:${server!.port}`;
    const created = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server!, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const session = (await created.json()) as { data: { id: string } };
    const res = await fetch(`${base}/api/v1/sessions/${session.data.id}/skills`, {
      headers: authHeaders(server!),
    } as never);
    const body = (await res.json()) as { data: { skills: { name: string; type?: string }[] } };
    const flow = body.data.skills.find((s) => s.name === 'issue-fix');
    console.log('SKILLS:', body.data.skills.map((s) => `${s.name}(${s.type ?? '-'})`).join(', '));
    expect(flow).toBeDefined();
    expect(flow?.type).toBe('flow');
  });
});
