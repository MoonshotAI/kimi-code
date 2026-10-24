/**
 * Scenario: startup `--agent` / `--agent-file` profile binding on interactive
 * session creation (agent-core-v2 engine).
 * Responsibilities: a session created through the v2 SDK client with
 * `agentProfile` binds that profile as the main agent — so the profile's
 * `tools` / `disallowedTools` policy is enforced in interactive sessions too,
 * not just `-p` print mode. Without an explicit profile the main agent falls
 * back to the default profile (v1's eager equivalent).
 * Wiring: real agent-core-v2 engine in-process on a temp KIMI_CODE_HOME; no
 * provider calls (the configured model is never invoked).
 * Run: pnpm -C packages/node-sdk exec vitest run test/session-agent-profile.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureMainAgent,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentProfileService,
} from '@moonshot-ai/agent-core-v2';
import { ISessionAgentProfileCatalog } from '@moonshot-ai/agent-core-v2/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';

import { SDKRpcClientV2 } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeTestHome(homeDir: string): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."kimi-test-model"]
provider = "local"
model = "kimi-test-model"
max_context_size = 1000
`,
    'utf-8',
  );
  const agentDir = join(homeDir, 'agents');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'restricted.md'),
    `---
name: restricted
description: Read-only test agent with a tools allowlist.
tools:
  - Read
  - Glob
---

You are a read-only test agent.
`,
    'utf-8',
  );
}

async function mainAgentProfileData(rpc: SDKRpcClientV2, sessionId: string) {
  const session = getLiveSessionById(rpc.engineAccessor, sessionId);
  if (session === undefined) {
    throw new Error(`live session "${sessionId}" not found`);
  }
  const context = await ensureMainAgent(session);
  const agent = session.accessor.get(IAgentLifecycleService).handleOf(context.agentId);
  if (agent === undefined) {
    throw new Error(`main agent of "${sessionId}" not found`);
  }
  return agent.accessor.get(IAgentProfileService).data();
}

describe('SDKRpcClientV2.createSession startup agent profile', () => {
  it('binds the --agent profile so its tools policy applies to the interactive main agent', async () => {
    const homeDir = await makeTempDir('kimi-sdk-agent-profile-home-');
    const workDir = await makeTempDir('kimi-sdk-agent-profile-work-');
    await writeTestHome(homeDir);
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const summary = await rpc.createSession({
        workDir,
        model: 'kimi-test-model',
        agentProfile: 'restricted',
      });
      const data = await mainAgentProfileData(rpc, summary.id);
      expect(data.profileName).toBe('restricted');
      expect(data.activeToolNames).toEqual(['Read', 'Glob']);
    } finally {
      await rpc.close();
    }
  });

  it('falls back to the default profile when no --agent is selected', async () => {
    const homeDir = await makeTempDir('kimi-sdk-agent-profile-home-');
    const workDir = await makeTempDir('kimi-sdk-agent-profile-work-');
    await writeTestHome(homeDir);
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const summary = await rpc.createSession({
        workDir,
        model: 'kimi-test-model',
      });
      const data = await mainAgentProfileData(rpc, summary.id);
      expect(data.profileName).toBe('agent');
    } finally {
      await rpc.close();
    }
  });

  it('binds an --agent-file profile that is not discoverable from user/project agent dirs', async () => {
    const homeDir = await makeTempDir('kimi-sdk-agent-file-home-');
    const workDir = await makeTempDir('kimi-sdk-agent-file-work-');
    await writeTestHome(homeDir);
    // Supplied solely through `agentFiles`: the file lives at the (otherwise
    // empty) workDir root — not under <homeDir>/agents and not under any
    // project agent root (.kimi-code/agents / .agents/agents) — so only the
    // session's own agent files (passed through to session create) can
    // register it. Without that registration the parsed profile name is absent
    // from the session catalog and `profile.bind` would reject it as unknown.
    const agentFilePath = join(workDir, 'explicit-only.md');
    await writeFile(
      agentFilePath,
      `---
name: explicit-only
description: Agent-file-only profile for the interactive --agent-file bind.
tools:
  - Read
  - Glob
---

You are an explicit agent-file-only profile.
`,
      'utf-8',
    );
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const summary = await rpc.createSession({
        workDir,
        model: 'kimi-test-model',
        agentFiles: [agentFilePath],
      });
      const data = await mainAgentProfileData(rpc, summary.id);
      expect(data.profileName).toBe('explicit-only');
      expect(data.activeToolNames).toEqual(['Read', 'Glob']);
    } finally {
      await rpc.close();
    }
  });

  it('leaves no session behind when the startup profile cannot be bound', async () => {
    const homeDir = await makeTempDir('kimi-sdk-agent-profile-home-');
    const workDir = await makeTempDir('kimi-sdk-agent-profile-work-');
    await writeTestHome(homeDir);
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const id = 'startup-profile-missing';
      await expect(
        rpc.createSession({ id, workDir, model: 'kimi-test-model', agentProfile: 'missing-agent' }),
      ).rejects.toThrow();
      expect(getLiveSessionById(rpc.engineAccessor, id)).toBeUndefined();
      const listed = await rpc.listSessions({ workDir });
      expect(listed.map((session) => session.id)).not.toContain(id);
      const retry = await rpc.createSession({ id, workDir, model: 'kimi-test-model' });
      expect(retry.id).toBe(id);
    } finally {
      await rpc.close();
    }
  });

  it('keeps --agent-file profiles scoped to the session that supplied them', async () => {
    const homeDir = await makeTempDir('kimi-sdk-agent-file-home-');
    const workDir = await makeTempDir('kimi-sdk-agent-file-work-');
    await writeTestHome(homeDir);
    const writeAgentFile = async (name: string, tool: string): Promise<string> => {
      const filePath = join(workDir, `${name}.md`);
      await writeFile(
        filePath,
        `---
name: ${name}
description: Agent-file-only profile ${name}.
tools:
  - ${tool}
---

You are ${name}.
`,
        'utf-8',
      );
      return filePath;
    };
    const alphaFile = await writeAgentFile('alpha-only', 'Read');
    const betaFile = await writeAgentFile('beta-only', 'Glob');
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    const catalogNames = (sessionId: string): string[] => {
      const session = getLiveSessionById(rpc.engineAccessor, sessionId);
      if (session === undefined) throw new Error(`live session "${sessionId}" not found`);
      return session.accessor
        .get(ISessionAgentProfileCatalog)
        .list()
        .map((profile) => profile.name);
    };
    try {
      const [alpha, beta] = await Promise.all([
        rpc.createSession({ workDir, model: 'kimi-test-model', agentFiles: [alphaFile] }),
        rpc.createSession({ workDir, model: 'kimi-test-model', agentFiles: [betaFile] }),
      ]);
      const plain = await rpc.createSession({ workDir, model: 'kimi-test-model' });

      expect((await mainAgentProfileData(rpc, alpha.id)).profileName).toBe('alpha-only');
      expect((await mainAgentProfileData(rpc, beta.id)).profileName).toBe('beta-only');
      expect(catalogNames(alpha.id)).toContain('alpha-only');
      expect(catalogNames(alpha.id)).not.toContain('beta-only');
      expect(catalogNames(beta.id)).toContain('beta-only');
      expect(catalogNames(beta.id)).not.toContain('alpha-only');
      expect(catalogNames(plain.id)).not.toContain('alpha-only');
      expect(catalogNames(plain.id)).not.toContain('beta-only');
    } finally {
      await rpc.close();
    }
  });
});
