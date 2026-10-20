import { describe, expect, it, vi } from 'vitest';

import { Session, type QuestionHandler, type QuestionRequest, type QuestionResult } from '#/index';
import type { SDKRpcClientBase } from '#/rpc';

describe('Session question handler', () => {
  it('registers a question handler and returns handler results', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_question_handler',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    const handler = vi.fn(async (request: QuestionRequest) => {
      expect(request).toMatchObject({
        questions: [
          {
            question: 'Pick one?',
            options: [{ label: 'A' }],
          },
        ],
      });
      return { 'Pick one?': 'A' };
    });
    session.setQuestionHandler(handler);

    await expect(
      rpc.requestQuestion(session.id, 'main', questionRequest('Pick one?')),
    ).resolves.toEqual({ 'Pick one?': 'A' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sends null question results when no handler is registered', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_question_default',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });

    await expect(
      rpc.requestQuestion(session.id, 'main', questionRequest('Continue?')),
    ).resolves.toBeNull();
    await session.close();
    expect(rpc.closeSession).toHaveBeenCalledWith({ sessionId: session.id });
  });

  it('sends null question results when the handler throws', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_question_throw',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    session.setQuestionHandler(() => {
      throw new Error('boom');
    });

    await expect(
      rpc.requestQuestion(session.id, 'main', questionRequest('Continue?')),
    ).resolves.toBeNull();
  });

  it('responds to concurrent question requests', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_question_concurrent',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    session.setQuestionHandler((request) => ({ [request.questions[0]!.question]: true }));

    await expect(rpc.requestQuestion(session.id, 'main', questionRequest('A?'))).resolves.toEqual({
      'A?': true,
    });
    await expect(rpc.requestQuestion(session.id, 'main', questionRequest('B?'))).resolves.toEqual({
      'B?': true,
    });
  });

  it('responds to the original subagent id', async () => {
    const rpc = new FakeSDKRpcClient();
    const session = new Session({
      id: 'ses_question_subagent',
      workDir: '/tmp',
      rpc: rpc.asRpc(),
    });
    const handler = vi.fn(() => ({ 'Continue?': 'yes' }));
    session.setQuestionHandler(handler);

    await expect(
      rpc.requestQuestion(session.id, 'agent-1', questionRequest('Continue?')),
    ).resolves.toEqual({ 'Continue?': 'yes' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.id,
        agentId: 'agent-1',
      }),
    );
  });
});

function questionRequest(question: string): QuestionRequest {
  return {
    questions: [
      {
        question,
        options: [{ label: 'A' }],
      },
    ],
  };
}

class FakeSDKRpcClient {
  private readonly questionHandlers = new Map<string, QuestionHandler>();
  readonly closeSession = vi.fn(async (_input: { readonly sessionId: string }) => {});

  asRpc(): SDKRpcClientBase {
    return this as unknown as SDKRpcClientBase;
  }

  setQuestionHandler(sessionId: string, handler: QuestionHandler | undefined): void {
    if (handler === undefined) {
      this.questionHandlers.delete(sessionId);
      return;
    }
    this.questionHandlers.set(sessionId, handler);
  }

  async requestQuestion(
    sessionId: string,
    agentId: string,
    request: QuestionRequest,
  ): Promise<QuestionResult> {
    const handler = this.questionHandlers.get(sessionId);
    if (handler === undefined) return null;
    try {
      return await handler({ ...request, sessionId, agentId } as QuestionRequest);
    } catch {
      return null;
    }
  }

  clearSessionHandlers(sessionId: string): void {
    this.questionHandlers.delete(sessionId);
  }
}
