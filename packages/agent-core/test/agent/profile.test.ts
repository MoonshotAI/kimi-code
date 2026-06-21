import { describe, expect, it, vi } from 'vitest';

import type { Kaos } from '@moonshot-ai/kaos';

import { AgentProfileService, type AgentProfileHost } from '../../src/agent/profile';
import type { IAgentConfigService } from '../../src/agent/config';
import type { IAgentSkillService } from '../../src/agent/skill';
import type { IAgentToolService } from '../../src/agent/tool';
import type {
  PreparedSystemPromptContext,
  ResolvedAgentProfile,
  SystemPromptRenderer,
} from '../../src/profile';

const FAKE_OS_ENV = { os: 'linux', shell: 'bash' };
const FAKE_REGISTRY = { kind: 'fake-skill-registry' };

interface ProfileServiceHarness {
  readonly service: AgentProfileService;
  readonly profile: ResolvedAgentProfile & { systemPrompt: ReturnType<typeof vi.fn<SystemPromptRenderer>> };
  readonly config: { readonly cwd: string; readonly update: ReturnType<typeof vi.fn> };
  readonly tools: { readonly setActiveTools: ReturnType<typeof vi.fn> };
  readonly kaos: { readonly osEnv: typeof FAKE_OS_ENV };
}

function makeProfileServiceHost(options: { withSkills?: boolean } = {}): ProfileServiceHarness {
  const systemPrompt = vi.fn<SystemPromptRenderer>().mockReturnValue('RENDERED_PROMPT');
  const profile = {
    name: 'tester',
    tools: ['Bash', 'Read'],
    systemPrompt,
  } satisfies ResolvedAgentProfile;

  const config = {
    cwd: '/work',
    update: vi.fn(),
  };
  const tools = {
    setActiveTools: vi.fn(),
  };
  const skills = options.withSkills ? { registry: FAKE_REGISTRY } : null;
  const kaos = { osEnv: FAKE_OS_ENV };

  const host: AgentProfileHost = {
    kaos: kaos as unknown as Kaos,
    config: config as unknown as IAgentConfigService,
    skills: skills as unknown as IAgentSkillService | null,
    tools: tools as unknown as IAgentToolService,
  };

  return {
    service: new AgentProfileService(host),
    profile,
    config,
    tools,
    kaos,
  };
}

describe('AgentProfileService', () => {
  it('calls config.update with { profileName, systemPrompt } and tools.setActiveTools with profile.tools', () => {
    const harness = makeProfileServiceHost();

    harness.service.useProfile(harness.profile);

    expect(harness.config.update).toHaveBeenCalledTimes(1);
    expect(harness.config.update).toHaveBeenCalledWith({
      profileName: 'tester',
      systemPrompt: 'RENDERED_PROMPT',
    });
    expect(harness.tools.setActiveTools).toHaveBeenCalledTimes(1);
    expect(harness.tools.setActiveTools).toHaveBeenCalledWith(['Bash', 'Read']);
  });

  it('builds the system prompt from the profile, host runtime, and prepared context', () => {
    const harness = makeProfileServiceHost({ withSkills: true });
    const context: PreparedSystemPromptContext = {
      cwdListing: 'LISTING',
      agentsMd: 'AGENTS',
    };

    harness.service.useProfile(harness.profile, context);

    expect(harness.profile.systemPrompt).toHaveBeenCalledTimes(1);
    expect(harness.profile.systemPrompt).toHaveBeenCalledWith({
      osEnv: FAKE_OS_ENV,
      cwd: '/work',
      skills: FAKE_REGISTRY,
      cwdListing: 'LISTING',
      agentsMd: 'AGENTS',
    });
  });

  it('passes undefined skills / cwdListing / agentsMd when the host has no skills and no context is supplied', () => {
    const harness = makeProfileServiceHost();

    harness.service.useProfile(harness.profile);

    expect(harness.profile.systemPrompt).toHaveBeenCalledWith({
      osEnv: FAKE_OS_ENV,
      cwd: '/work',
      skills: undefined,
      cwdListing: undefined,
      agentsMd: undefined,
    });
  });
});
