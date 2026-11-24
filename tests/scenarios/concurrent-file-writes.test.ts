import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KapProcess } from '@moonshot-ai/testkit/kap';
import { homeFixtures, type HomeFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

const test = base.extend<HomeFixtures>(homeFixtures());

test('two KAP processes sharing a home cannot both replace the same revision', { timeout: 90_000 }, async ({ testHome }) => {
  const servers: KapProcess[] = [];
  try {
    servers.push(await KapProcess.start({ home: testHome }));
    servers.push(await KapProcess.start({ home: testHome }));
    expect(servers[0]!.pid).not.toBe(servers[1]!.pid);
    const path = join(testHome.dataDir, 'AGENTS.md');
    const original = 'a'.repeat(8 * 1024 * 1024);
    await writeFile(path, original);
    const revision = createHash('sha256').update(original).digest('hex');
    const query = new URLSearchParams({ path, revision });
    const results = await Promise.all(servers.map(async (server, index) => {
      const body = `saved by writer ${index}`;
      const res = await fetch(`${server.origin}/api/v1/fs:content?${query.toString()}`, {
        method: 'PUT', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'text/plain' }, body,
      });
      return { body, status: res.status, envelope: await res.json() as { code: number } };
    }));
    expect(results.map(r => r.status).toSorted()).toEqual([200, 412]);
    expect(results.find(r => r.status === 412)?.envelope.code).toBe(41201);
    expect(await readFile(path, 'utf8')).toBe(results.find(r => r.status === 200)?.body);
  } finally {
    await Promise.all(servers.map(server => server.close()));
  }
});
