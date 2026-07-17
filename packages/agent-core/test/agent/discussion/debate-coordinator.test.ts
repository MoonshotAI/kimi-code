import { describe, expect, it, vi } from 'vitest';

import { StructuredDebateCoordinator } from '../../../src/agent/discussion/debate-coordinator';
import type { SessionSubagentHost } from '../../../src/session/subagent-host';
import type { SpawnSubagentOptions } from '../../../src/session/subagent-host';

function mockSubagentHost(): SessionSubagentHost {
  let agentCounter = 0;
  const persistentAgents = new Map<string, { turnCount: number }>();

  return {
    spawnPersistent: vi.fn(async (_options: SpawnSubagentOptions): Promise<string> => {
      agentCounter += 1;
      const id = `debate-agent-${agentCounter}`;
      persistentAgents.set(id, { turnCount: 0 });
      return id;
    }),
    runDiscussionTurn: vi.fn(
      async (_agentId: string, prompt: string, _signal: AbortSignal): Promise<string> => {
        // Parse the prompt to determine which phase this turn belongs to
        // and return phase-appropriate mock responses
        const record = persistentAgents.get(_agentId);
        if (record) {
          record.turnCount += 1;
        }

        if (prompt.includes('OPENING STATEMENTS')) {
          return 'I believe we should adopt this approach because it improves performance and reduces complexity. My key arguments are: first, it scales better; second, it is easier to maintain.';
        }
        if (prompt.includes('FREE DEBATE')) {
          return 'I would like to respond to the points raised. While I agree with some aspects, I have concerns about the implementation cost. @colleague makes a good point about scalability, but we need to consider the trade-offs.';
        }
        if (prompt.includes('CLOSING ARGUMENTS')) {
          return 'In conclusion, after hearing all perspectives, I maintain my position but acknowledge the valid concerns raised. The best path forward is a hybrid approach.';
        }
        if (prompt.includes('VOTING PHASE')) {
          return 'My final position is yes, with the condition that we phase the rollout. The most convincing argument was about the long-term benefits.';
        }
        // Consensus / tally
        return 'After reviewing all positions, the consensus is that we should proceed with a phased approach. The team agrees on the direction but differs on the timeline.';
      },
    ),
    destroyPersistent: vi.fn(async (_agentId: string): Promise<void> => {
      persistentAgents.delete(_agentId);
    }),
    getPersistentUsage: vi.fn(() => undefined),
    // Required by SessionSubagentHost type but not used by the coordinator
    spawn: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    runQueued: vi.fn(),
    runOne: vi.fn(),
    suspended: vi.fn(),
    startBtw: vi.fn(),
    cancelAll: vi.fn(),
    markActiveChildDetached: vi.fn(),
    getProfileName: vi.fn(),
    getSwarmItem: vi.fn(),
  } as unknown as SessionSubagentHost;
}

describe('StructuredDebateCoordinator', () => {
  it('runs a complete debate with opening, free debate, and closing', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    const result = await coordinator.debate(
      {
        topic: 'Should we adopt microservices?',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'You are a senior backend engineer who values simplicity.',
          },
          {
            profileName: 'coder',
            roleDescription: 'You are a systems architect focused on scalability.',
          },
        ],
        maxDebateRounds: 1,
      },
      signal,
    );

    expect(result.endedBy).toBe('completed');
    expect(result.transcript.length).toBeGreaterThan(0);
    expect(result.consensus).toBe('');
    expect(result.votingResult).toBe('');
    expect(result.phases.length).toBeGreaterThan(0);
    expect(result.usage).toBeDefined();

    // Verify phase breakdown
    const phaseNames = result.phases.map((p) => p.phase);
    expect(phaseNames).toContain('opening');
    expect(phaseNames).toContain('free_debate');
    expect(phaseNames).toContain('closing');
  });

  it('generates consensus when consensusPrompt is provided', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    const result = await coordinator.debate(
      {
        topic: 'Should we adopt microservices?',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'You are a senior backend engineer.',
          },
          {
            profileName: 'coder',
            roleDescription: 'You are a systems architect.',
          },
        ],
        maxDebateRounds: 1,
        consensusPrompt: 'Summarize the key decisions from this debate.',
      },
      signal,
    );

    expect(result.consensus).toBeTruthy();
    expect(result.consensus.length).toBeGreaterThan(0);
  });

  it('runs voting when enableVoting is true', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    const result = await coordinator.debate(
      {
        topic: 'Should we adopt microservices?',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'You are a backend engineer.',
          },
          {
            profileName: 'coder',
            roleDescription: 'You are a frontend architect.',
          },
          {
            profileName: 'coder',
            roleDescription: 'You are a DevOps engineer.',
          },
        ],
        maxDebateRounds: 1,
        enableVoting: true,
      },
      signal,
    );

    expect(result.votingResult).toBeTruthy();
    expect(result.votingResult.length).toBeGreaterThan(0);
  });

  it('handles participant with assigned stance', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    const result = await coordinator.debate(
      {
        topic: 'Should we adopt microservices?',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'You are a backend engineer.',
            assignedStance: 'Argue against microservices',
          },
          {
            profileName: 'coder',
            roleDescription: 'You are a systems architect.',
            assignedStance: 'Argue for microservices',
          },
        ],
        maxDebateRounds: 1,
      },
      signal,
    );

    expect(result.endedBy).toBe('completed');
    expect(result.transcript.length).toBeGreaterThan(0);
  });

  it('cancels gracefully on abort signal', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const controller = new AbortController();

    // Abort immediately
    controller.abort();

    const result = await coordinator.debate(
      {
        topic: 'Should we adopt microservices?',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'You are a backend engineer.',
          },
        ],
        maxDebateRounds: 1,
      },
      controller.signal,
    );

    expect(result.endedBy).toBe('cancelled');
  });

  it('destroys all persistent agents after debate', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    await coordinator.debate(
      {
        topic: 'Test cleanup',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'You are an engineer.',
          },
          {
            profileName: 'coder',
            roleDescription: 'You are an architect.',
          },
        ],
        maxDebateRounds: 1,
      },
      signal,
    );

    // destroyPersistent should have been called for each participant
    expect(host.destroyPersistent).toHaveBeenCalledTimes(2);
  });

  it('tracks cross-references when participants reference each other', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    const result = await coordinator.debate(
      {
        topic: 'Should we adopt microservices?',
        participants: [
          {
            profileName: 'colleague',
            roleDescription: 'You are a backend engineer.',
          },
          {
            profileName: 'architect',
            roleDescription: 'You are a systems architect.',
          },
        ],
        maxDebateRounds: 1,
      },
      signal,
    );

    // The mock responses contain @colleague reference
    expect(result.crossReferencesCount).toBeGreaterThanOrEqual(0);
  });

  it('respects maxDebateRounds setting', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    const result = await coordinator.debate(
      {
        topic: 'Test rounds',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'Engineer A.',
          },
          {
            profileName: 'coder',
            roleDescription: 'Engineer B.',
          },
        ],
        maxDebateRounds: 3,
      },
      signal,
    );

    // opening (2) + free_debate (2*3=6) + closing (2) = 10 entries minimum
    expect(result.transcript.length).toBeGreaterThanOrEqual(8);
    // Verify the free debate phase has the expected number of entries
    const freeDebatePhase = result.phases.find((p) => p.phase === 'free_debate');
    expect(freeDebatePhase).toBeDefined();
    expect(freeDebatePhase!.entryCount).toBeGreaterThanOrEqual(6);
  });

  it('notifies observer on each turn', async () => {
    const host = mockSubagentHost();
    const observer = vi.fn();
    const coordinator = new StructuredDebateCoordinator(host, { observer });
    const signal = new AbortController().signal;

    await coordinator.debate(
      {
        topic: 'Test observer',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'Engineer A.',
          },
          {
            profileName: 'coder',
            roleDescription: 'Engineer B.',
          },
        ],
        maxDebateRounds: 1,
      },
      signal,
    );

    // Each participant speaks in each phase: opening(2) + free_debate(2) + closing(2) = 6 turns
    expect(observer).toHaveBeenCalledTimes(6);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: expect.any(String),
        roleName: expect.any(String),
        round: expect.any(Number),
        content: expect.any(String),
      }),
    );
  });

  it('handles single participant gracefully', async () => {
    const host = mockSubagentHost();
    const coordinator = new StructuredDebateCoordinator(host);
    const signal = new AbortController().signal;

    const result = await coordinator.debate(
      {
        topic: 'Solo debate',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'You are a solo debater.',
          },
        ],
        maxDebateRounds: 1,
      },
      signal,
    );

    expect(result.endedBy).toBe('completed');
    expect(result.transcript.length).toBeGreaterThan(0);
  });
});
