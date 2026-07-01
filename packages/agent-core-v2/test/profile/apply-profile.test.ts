import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionAgentFileSystem } from '#/session/agentFs/agentFsService';
import { createExecContext } from '#/session/execContext';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile';

import { createTestAgent, execEnvServices, type TestAgentContext } from '../harness';

const profile: ResolvedAgentProfile = {
  name: 'agents-profile',
  systemPrompt: (context) =>
    typeof context['agentsMd'] === 'string' ? (context['agentsMd'] as string) : '',
  tools: [],
};

describe('AgentProfileService.applyProfile', () => {
  let ctx: TestAgentContext;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-apply-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-apply-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  function buildContext(): { ctx: TestAgentContext; profile: IAgentProfileService } {
    // Real session-scoped fs anchored at workDir, plus a hermetic home dir
    // (empty temp dir) so a developer's real ~/.kimi-code / ~/.agents files
    // never leak into the assertions.
    const execCtx = createExecContext(workDir);
    const fs = new SessionAgentFileSystem(execCtx);
    ctx = createTestAgent(
      execEnvServices({
        hostEnvironment: { homeDir },
        execContext: execCtx,
        agentFs: fs,
      }),
    );
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  it('loads AGENTS.md into the rendered system prompt', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain('project instructions');
    expect(svc.data().systemPrompt).toContain(`<!-- From: ${join(workDir, 'AGENTS.md')} -->`);
    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });

  it('caches an agents-md warning when the content exceeds the 32 KB soft budget', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');
    const { ctx: context, profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain(largeContent);
    const warning = svc.getAgentsMdWarning();
    expect(warning).toBeDefined();
    expect(warning).toContain('exceeds the recommended');

    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    expect(
      events.some(
        (entry) => entry.event === 'warning' && entry.args?.code === 'agents-md-oversized',
      ),
    ).toBe(true);
  });

  it('does not cache a warning when the content is within the budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });
});
