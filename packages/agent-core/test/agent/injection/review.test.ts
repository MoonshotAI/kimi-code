import { describe, expect, it } from 'vitest';

import { Agent } from '../../../src/agent';
import { SessionReviewRuntime } from '../../../src/review';
import { createFakeKaos } from '../../tools/fixtures/fake-kaos';

describe('ReviewInjector', () => {
  it('injects review background and assignment for review workers', async () => {
    const review = createReviewFacade();
    const agent = new Agent({ kaos: createFakeKaos(), review });

    await agent.injection.inject();

    expect(historyText(agent)).toContain('<review-background>');
    expect(historyText(agent)).toContain('"intensity": "standard"');
    expect(historyText(agent)).toContain('<review-assignment>');
    expect(historyText(agent)).toContain('"assignedFiles"');
  });

  it('injects review background again after compaction', async () => {
    const review = createReviewFacade();
    const agent = new Agent({ kaos: createFakeKaos(), review });

    await agent.injection.inject();
    const firstLength = agent.context.history.length;
    agent.injection.onContextCompacted(firstLength);
    await agent.injection.inject();

    expect(agent.context.history.length).toBe(firstLength + 1);
    expect(historyText(agent).match(/<review-background>/g)).toHaveLength(2);
  });
});

function createReviewFacade() {
  const runtime = new SessionReviewRuntime({
    idGenerator: (prefix) => `${prefix}-1`,
  });
  runtime.startReview(
    { target: { scope: 'working_tree' }, intensity: 'standard', focus: 'security' },
    {
      fileCount: 1,
      additions: 1,
      deletions: 0,
      files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
    },
  );
  const assignment = runtime.createAssignment({
    role: 'reviewer',
    perspective: 'security',
    assignedFiles: ['src/a.ts'],
    requiredCoverage: 'patch',
  });
  return runtime.createAgentFacade(assignment.id);
}

function historyText(agent: Agent): string {
  return agent.context.history
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
