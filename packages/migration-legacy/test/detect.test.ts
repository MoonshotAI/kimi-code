import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oldMd5BucketName } from '../src/sessions/workdir-bucket.js';
import { detectMigration } from '../src/detect.js';

let src: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'detect-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
});

describe('detectMigration', () => {
  it('returns empty totals when source dir is empty', async () => {
    const plan = await detectMigration({ sourcePath: src });
    expect(plan.hasConfig).toBe(false);
    expect(plan.hasMcp).toBe(false);
    expect(plan.totalSessions).toBe(0);
  });

  it('detects config/mcp/credentials/user-history/plugins/mcp-oauth presence', async () => {
    await writeFile(join(src, 'config.toml'), '');
    await writeFile(join(src, 'mcp.json'), '{"mcpServers":{}}');
    await mkdir(join(src, 'credentials'), { recursive: true });
    await writeFile(join(src, 'credentials', 'kimi-code.json'), '{}');
    await mkdir(join(src, 'user-history'), { recursive: true });
    await mkdir(join(src, 'plugins', 'p1'), { recursive: true });
    await mkdir(join(src, 'mcp-oauth'), { recursive: true });
    await writeFile(join(src, 'mcp-oauth', 'server-1'), '');

    const plan = await detectMigration({ sourcePath: src });
    expect(plan.hasConfig).toBe(true);
    expect(plan.hasMcp).toBe(true);
    expect(plan.hasUserHistory).toBe(true);
    expect(plan.oauthCredentials).toEqual(['kimi-code.json']);
    expect(plan.detectedPlugins).toEqual(['p1']);
    expect(plan.detectedMcpOauthServers).toContain('server-1');
  });

  it('reports an unknown workdir bucket when kimi.json cannot map it', async () => {
    const bucket = join(src, 'sessions', oldMd5BucketName('/workspace/example'));
    await mkdir(join(bucket, 'legacy-session'), { recursive: true });
    await writeFile(
      join(bucket, 'legacy-session', 'context.jsonl'),
      '{"role":"user","content":"hello"}\n',
    );

    const plan = await detectMigration({ sourcePath: src });

    expect(plan.totalSessions).toBe(0);
    expect(plan.sessionScanFailures).toEqual([
      {
        sourcePath: bucket,
        reason: expect.stringMatching(/workdir.*kimi\.json/i),
      },
    ]);
  });

});
