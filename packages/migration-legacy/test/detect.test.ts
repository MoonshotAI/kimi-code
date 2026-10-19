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
    await writeFile(
      join(src, 'mcp.json'),
      '{"mcpServers":{"server-1":{"url":"https://example.test/mcp","auth":"oauth"},"server-2":{"command":"npx"}}}',
    );
    await mkdir(join(src, 'credentials'), { recursive: true });
    await writeFile(join(src, 'credentials', 'kimi-code.json'), '{}');
    await mkdir(join(src, 'user-history'), { recursive: true });
    await mkdir(join(src, 'plugins', 'p1'), { recursive: true });
    await mkdir(join(src, 'mcp-oauth'), { recursive: true });
    await writeFile(join(src, 'mcp-oauth', 'mangled-store-entry'), '');

    const plan = await detectMigration({ sourcePath: src });
    expect(plan.hasConfig).toBe(true);
    expect(plan.hasMcp).toBe(true);
    expect(plan.hasUserHistory).toBe(true);
    expect(plan.oauthCredentials).toEqual(['kimi-code']);
    expect(plan.detectedPlugins).toEqual(['p1']);
    expect(plan.detectedMcpOauthServers).toEqual(['server-1']);
  });

  it('derives OAuth relogin notices from config oauth refs even without credential files', async () => {
    await writeFile(
      join(src, 'config.toml'),
      '[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://api.example.test/v1"\n\n[providers."managed:kimi-code".oauth]\nstorage = "keyring"\nkey = "oauth/kimi-code"\n',
    );

    const plan = await detectMigration({ sourcePath: src });
    expect(plan.oauthCredentials).toEqual(['kimi-code']);
  });

  it('treats a config.json-only source as having config', async () => {
    await writeFile(join(src, 'config.json'), '{"default_model":"m"}');

    const plan = await detectMigration({ sourcePath: src });
    expect(plan.hasConfig).toBe(true);
  });

  it('counts historical flat sessions and title-only sessions', async () => {
    const workdir = '/workspace/flat-proj';
    const bucket = join(src, 'sessions', oldMd5BucketName(workdir));
    await mkdir(join(bucket, 'titled'), { recursive: true });
    await writeFile(join(src, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workdir }] }));
    await writeFile(join(bucket, 'flat-1.jsonl'), '{"role":"user","content":"hi"}\n');
    await writeFile(join(bucket, 'titled', 'context.jsonl'), '');
    await writeFile(
      join(bucket, 'titled', 'state.json'),
      JSON.stringify({ custom_title: 'Named' }),
    );

    const plan = await detectMigration({ sourcePath: src });
    expect(plan.totalSessions).toBe(2);
    expect(plan.sessionScanFailures).toEqual([]);
    expect(plan.workdirs[0]?.sessions.map((s) => s.uuid).sort()).toEqual(['flat-1', 'titled']);
  });

  it('detects a skills-only source', async () => {
    await mkdir(join(src, 'skills', 'my-skill'), { recursive: true });
    await writeFile(join(src, 'skills', 'my-skill', 'SKILL.md'), '# skill');

    const plan = await detectMigration({ sourcePath: src });
    expect(plan.hasSkills).toBe(true);
  });

  it('detects legacy plan files via the injectable plans source dir', async () => {
    const plansDir = await mkdtemp(join(tmpdir(), 'detect-plans-'));
    try {
      await writeFile(join(plansDir, 'hero.md'), '# plan');
      const plan = await detectMigration({ sourcePath: src, plansSourcePath: plansDir });
      expect(plan.hasPlans).toBe(true);
      const empty = await detectMigration({ sourcePath: src, plansSourcePath: join(plansDir, 'nope') });
      expect(empty.hasPlans).toBe(false);
    } finally {
      await rm(plansDir, { recursive: true, force: true });
    }
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
