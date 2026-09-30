import { readFile } from 'node:fs/promises';

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core';
import {
  agentProfileFromFile,
  parseAgentFileText,
  ProfileCatalogRef,
} from '@moonshot-ai/harness-core';
import { KimiSession, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

export interface StartupProfileSelection {
  readonly agentName?: string;
  readonly agentFile?: string;
  readonly cwd: string;
}

export async function resolveStartupSystemPrompt(
  harness: KimiHarness,
  selection: StartupProfileSelection,
): Promise<string | undefined> {
  const { agentName, agentFile, cwd } = selection;
  if (agentName === undefined && agentFile === undefined) return undefined;
  const catalog = harness.app.resolve(ProfileCatalogRef);
  if (catalog === undefined) throw new Error('profiles feature is not installed');
  await catalog.ready;
  if (agentFile !== undefined) {
    const text = await readFile(agentFile, 'utf-8');
    const definition = parseAgentFileText({ path: agentFile, source: 'explicit', text });
    const profile = agentProfileFromFile(definition, (context) =>
      catalog.getDefault().renderSystemPrompt(context),
    );
    return profile.renderSystemPrompt({ cwd }).text;
  }
  if (agentName === undefined) return undefined;
  const profile = catalog.get(agentName);
  if (profile === undefined) {
    throw new Error(
      `Agent profile "${agentName}" not found. Check the profile name or load a definition via --agent-file.`,
    );
  }
  return profile.renderSystemPrompt({ cwd }).text;
}

export async function createSessionWithStartupProfile(
  harness: KimiHarness,
  selection: StartupProfileSelection,
): Promise<KimiSession> {
  const systemPrompt = await resolveStartupSystemPrompt(harness, selection);
  if (systemPrompt === undefined) return harness.createSession();
  const handle = await harness.app.open({});
  try {
    const main = await handle.create({ agentId: MAIN_AGENT_ID, systemPrompt });
    return new KimiSession(handle.sessionId, handle, main, async (id) => {
      await harness.app.close(id);
    });
  } catch (error) {
    await harness.app.close(handle.sessionId).catch(() => {});
    throw error;
  }
}
