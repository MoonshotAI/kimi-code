import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { CoreAPI, RPCMethods } from '@moonshot-ai/agent-core';

import { SDKRpcClientBase } from '#/rpc';
import { Session } from '#/session';
import type {
  ReviewResult,
  ReviewScopeInput,
  ReviewStartInput,
  ReviewTarget,
  ReviewTargetPreview,
} from '#/types';

const target = { scope: 'working_tree' } satisfies ReviewTarget;
const preview = {
  target,
  stats: {
    fileCount: 1,
    additions: 1,
    deletions: 0,
    files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
  },
} satisfies ReviewTargetPreview;
const result = {
  ...preview,
  intensity: 'standard',
  status: 'complete',
  summary: 'Review completed.',
  comments: [],
} satisfies ReviewResult;

function makeSession() {
  const rpc = {
    listReviewBaseRefs: vi.fn(async () => [{ name: 'main', kind: 'branch' }]),
    listReviewCommits: vi.fn(async () => [{ sha: 'abc', title: 'change' }]),
    previewReviewTarget: vi.fn(async () => preview),
    startReview: vi.fn(async () => result),
    cancelReview: vi.fn(async () => {}),
    clearSessionHandlers: vi.fn(),
  } as unknown as SDKRpcClientBase;
  const session = new Session({ id: 'ses_review', workDir: '/tmp/work', rpc });
  return { session, rpc };
}

class ReviewRpcClient extends SDKRpcClientBase {
  constructor(private readonly core: Partial<RPCMethods<CoreAPI>>) {
    super();
  }

  protected override async getRpc(): Promise<RPCMethods<CoreAPI>> {
    return this.core as RPCMethods<CoreAPI>;
  }
}

describe('Session review methods', () => {
  it('forwards session review calls through the SDK client', async () => {
    const { session, rpc } = makeSession();
    const input = {
      target,
      intensity: 'standard',
      focus: 'security',
    } satisfies ReviewStartInput;

    await session.listReviewBaseRefs();
    await session.listReviewCommits();
    await session.previewReviewTarget(target);
    await session.startReview(input);
    await session.cancelReview();

    expect(rpc.listReviewBaseRefs).toHaveBeenCalledWith({ sessionId: 'ses_review' });
    expect(rpc.listReviewCommits).toHaveBeenCalledWith({ sessionId: 'ses_review' });
    expect(rpc.previewReviewTarget).toHaveBeenCalledWith({
      sessionId: 'ses_review',
      target,
    });
    expect(rpc.startReview).toHaveBeenCalledWith({
      sessionId: 'ses_review',
      ...input,
    });
    expect(rpc.cancelReview).toHaveBeenCalledWith({ sessionId: 'ses_review' });
  });

  it('forwards SDK RPC calls to core review RPC methods', async () => {
    const core = {
      listReviewBaseRefs: vi.fn(async () => []),
      listReviewCommits: vi.fn(async () => []),
      previewReviewTarget: vi.fn(async () => preview),
      startReview: vi.fn(async () => result),
      cancelReview: vi.fn(async () => {}),
    };
    const rpc = new ReviewRpcClient(core);

    await rpc.listReviewBaseRefs({ sessionId: 'ses_review' });
    await rpc.listReviewCommits({ sessionId: 'ses_review' });
    await rpc.previewReviewTarget({ sessionId: 'ses_review', target });
    await rpc.startReview({
      sessionId: 'ses_review',
      target,
      intensity: 'standard',
      focus: 'correctness',
    });
    await rpc.cancelReview({ sessionId: 'ses_review' });

    expect(core.listReviewBaseRefs).toHaveBeenCalledWith({ sessionId: 'ses_review' });
    expect(core.listReviewCommits).toHaveBeenCalledWith({ sessionId: 'ses_review' });
    expect(core.previewReviewTarget).toHaveBeenCalledWith({
      sessionId: 'ses_review',
      target,
    });
    expect(core.startReview).toHaveBeenCalledWith({
      sessionId: 'ses_review',
      target,
      intensity: 'standard',
      focus: 'correctness',
    });
    expect(core.cancelReview).toHaveBeenCalledWith({ sessionId: 'ses_review' });
  });

  it('exposes review scope as the SDK target input type', () => {
    expectTypeOf<ReviewScopeInput>().toEqualTypeOf<ReviewTarget>();
  });
});
