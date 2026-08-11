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
  IAgentProfileService,
} from '@moonshot-ai/agent-core-v2';

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
  const agent = await ensureMainAgent(session);
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
});
