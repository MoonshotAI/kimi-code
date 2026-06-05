/**
 * Tests for {@link AcpSession.handleQuestion} — the Phase 13.1 bridge
 * from the SDK's AskUserQuestion reverse-RPC to the ACP
 * `session/request_permission` surface.
 *
 * Uses a captured-handler pattern (mirrors `approval.test.ts`): the stub
 * `Session` records the `QuestionHandler` registered by the AcpSession
 * constructor, and the test invokes it directly as the SDK would.
 */
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  log,
  type QuestionAnswers,
  type QuestionHandler,
  type QuestionItem,
  type QuestionRequest,
  type QuestionResult,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpSession, type TelemetryTrackFn } from '../src/session';

/**
 * Build a stub {@link Session} that captures the question handler
 * registered by {@link AcpSession}'s constructor and exposes it for
 * the test to invoke as the SDK reverse-RPC layer would.
 */
function makeQuestionSession(sessionId: string): {
  session: Session;
  invokeHandler: (req: QuestionRequest) => Promise<QuestionResult>;
} {
  let questionHandler: QuestionHandler | undefined;
  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => undefined,
    cancel: async () => undefined,
    onEvent: () => () => undefined,
    setApprovalHandler: () => undefined,
    setQuestionHandler: (handler: QuestionHandler | undefined) => {
      questionHandler = handler;
    },
  } as unknown as Session;
  return {
    session,
    invokeHandler: async (req: QuestionRequest) => {
      if (!questionHandler) {
        throw new Error('question handler was not registered by AcpSession');
      }
      const result = await questionHandler(req);
      return result;
    },
  };
}

/**
 * Capturing connection — only `requestPermission` is exercised here;
 * everything else throws to surface accidental usage.
 */
class CapturingConn {
  readonly permissionRequests: RequestPermissionRequest[] = [];
  reply: RequestPermissionResponse = {
    outcome: { outcome: 'selected', optionId: 'q0_opt_0' },
  };
  shouldThrow = false;

  async requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(p);
    if (this.shouldThrow) {
      throw new Error('client unreachable');
    }
    return this.reply;
  }
  async sessionUpdate(): Promise<void> {
    /* not exercised */
  }
  async readTextFile(): Promise<{ content: string }> {
    throw new Error('not exercised');
  }
  async writeTextFile(): Promise<Record<string, never>> {
    throw new Error('not exercised');
  }
}

function makeConn(): { conn: AgentSideConnection; raw: CapturingConn } {
  const raw = new CapturingConn();
  return { conn: raw as unknown as AgentSideConnection, raw };
}

const sampleQuestion: QuestionItem = {
  question: '哪个口味？',
  options: [{ label: '香草' }, { label: '巧克力' }, { label: '抹茶' }],
};

function makeReq(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    toolCallId: 'tc-ask-1',
    questions: [sampleQuestion],
    ...overrides,
  };
}

describe('AcpSession.handleQuestion', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let trackCalls: Array<{ event: string; properties?: Record<string, unknown> }>;
  let track: TelemetryTrackFn;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    trackCalls = [];
    track = (event: string, properties?: Record<string, unknown>) => {
      trackCalls.push({ event, properties });
    };
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('registers a question handler at construction time', () => {
    const { conn } = makeConn();
    const { session } = makeQuestionSession('s-q-1');
    const setSpy = vi.fn();
    (session as unknown as { setQuestionHandler: typeof setSpy }).setQuestionHandler = setSpy;
    new AcpSession(conn, session, undefined, track);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(typeof setSpy.mock.calls[0]![0]).toBe('function');
  });

  it('happy path: forwards a single question and resolves with the matched answer + question_answered', async () => {
    const { conn, raw } = makeConn();
    const handle = makeQuestionSession('s-q-happy');
    raw.reply = { outcome: { outcome: 'selected', optionId: 'q0_opt_0' } };
    new AcpSession(conn, handle.session, undefined, track);

    const answer = await handle.invokeHandler(makeReq());

    expect(answer).toEqual({ '哪个口味？': '香草' } satisfies QuestionAnswers);
    expect(raw.permissionRequests).toHaveLength(1);
    const req = raw.permissionRequests[0]!;
    expect(req.sessionId).toBe('s-q-happy');
    // Options: 3 allow_once + 1 reject_once skip
    expect(req.options).toHaveLength(4);
    expect(req.options.map((o) => o.optionId)).toEqual([
      'q0_opt_0',
      'q0_opt_1',
      'q0_opt_2',
      'q0_skip',
    ]);
    expect(req.options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_once',
      'allow_once',
      'reject_once',
    ]);
    expect(req.toolCall.title).toBe('AskUserQuestion');
    // currentTurnId is undefined in this test path, so raw toolCallId is used.
    expect(req.toolCall.toolCallId).toBe('tc-ask-1');
    expect(req.toolCall.content).toEqual([
      { type: 'content', content: { type: 'text', text: '哪个口味？' } },
    ]);
    expect(trackCalls).toEqual([{ event: 'question_answered', properties: undefined }]);
  });

  it('skip: q0_skip resolves to null with question_dismissed telemetry', async () => {
    const { conn, raw } = makeConn();
    const handle = makeQuestionSession('s-q-skip');
    raw.reply = { outcome: { outcome: 'selected', optionId: 'q0_skip' } };
    new AcpSession(conn, handle.session, undefined, track);

    const answer = await handle.invokeHandler(makeReq());

    expect(answer).toBeNull();
    expect(trackCalls).toEqual([{ event: 'question_dismissed', properties: undefined }]);
  });

  it('cancelled: outcome cancelled resolves to null with question_dismissed', async () => {
    const { conn, raw } = makeConn();
    const handle = makeQuestionSession('s-q-cancel');
    raw.reply = { outcome: { outcome: 'cancelled' } };
    new AcpSession(conn, handle.session, undefined, track);

    const answer = await handle.invokeHandler(makeReq());

    expect(answer).toBeNull();
    expect(trackCalls).toEqual([{ event: 'question_dismissed', properties: undefined }]);
  });

  it('multi-question degradation: 3 questions → only first asked + question_degraded', async () => {
    const { conn, raw } = makeConn();
    const handle = makeQuestionSession('s-q-multi');
    raw.reply = { outcome: { outcome: 'selected', optionId: 'q0_opt_1' } };
    new AcpSession(conn, handle.session, undefined, track);

    const extra1: QuestionItem = { question: 'Q2', options: [{ label: 'a' }] };
    const extra2: QuestionItem = { question: 'Q3', options: [{ label: 'b' }] };
    const answer = await handle.invokeHandler(
      makeReq({ questions: [sampleQuestion, extra1, extra2] }),
    );

    expect(answer).toEqual({ '哪个口味？': '巧克力' });
    expect(raw.permissionRequests).toHaveLength(1);
    // Telemetry: degraded(multi_question) first, then answered.
    expect(trackCalls).toEqual([
      { event: 'question_degraded', properties: { reason: 'multi_question', dropped: 2 } },
      { event: 'question_answered', properties: undefined },
    ]);
    // log.warn fired with the dropped count.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('degrading to first question only'),
      expect.objectContaining({ dropped: 2 }),
    );
  });

  it('multiSelect degradation: still asks the question + question_degraded', async () => {
    const { conn, raw } = makeConn();
    const handle = makeQuestionSession('s-q-multisel');
    raw.reply = { outcome: { outcome: 'selected', optionId: 'q0_opt_0' } };
    new AcpSession(conn, handle.session, undefined, track);

    const multi: QuestionItem = {
      question: 'Pick any',
      options: [{ label: 'a' }, { label: 'b' }],
      multiSelect: true,
    };
    const answer = await handle.invokeHandler({
      toolCallId: 'tc-multi',
      questions: [multi],
    });

    expect(answer).toEqual({ 'Pick any': 'a' });
    expect(raw.permissionRequests).toHaveLength(1);
    expect(trackCalls).toEqual([
      { event: 'question_degraded', properties: { reason: 'multi_select' } },
      { event: 'question_answered', properties: undefined },
    ]);
  });

  it('requestPermission throw → log.warn + null', async () => {
    const { conn, raw } = makeConn();
    const handle = makeQuestionSession('s-q-throw');
    raw.shouldThrow = true;
    new AcpSession(conn, handle.session, undefined, track);

    const answer = await handle.invokeHandler(makeReq());

    expect(answer).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('requestPermission (question) failed'),
      expect.objectContaining({ toolCallId: 'tc-ask-1' }),
    );
    // No question_answered / question_dismissed emitted on throw — the
    // RPC failure is its own observability path (log.warn above).
    expect(trackCalls).toEqual([]);
  });

  it('no track sink: handler still runs without emitting telemetry', async () => {
    const { conn, raw } = makeConn();
    const handle = makeQuestionSession('s-q-no-track');
    raw.reply = { outcome: { outcome: 'selected', optionId: 'q0_opt_0' } };
    // No track passed.
    new AcpSession(conn, handle.session);

    const answer = await handle.invokeHandler(makeReq());

    expect(answer).toEqual({ '哪个口味？': '香草' });
    expect(trackCalls).toEqual([]);
  });
});
