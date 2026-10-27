import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import {
  AskUserQuestionInputSchema,
  IAskUserQuestionTool,
  type AskUserQuestionInput,
} from '#/agent/tools/ask-user-question/ask-user-question';
import { AskUserQuestionTool } from '#/agent/tools/ask-user-question/askUserQuestionTool';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type {
  QuestionRequest,
  QuestionResult,
} from '#/agent/interaction/question';
import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_TURN_ID,
} from '#/human/interaction/interaction';
import { interactions } from '#/human/interaction/facade';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type {
  QuestionBackgroundTask,
  QuestionTaskInfo,
} from '#/agent/tools/ask-user-question/question-background-task';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;
const TASK_TOOLS = new Set(['TaskList', 'TaskOutput', 'TaskStop']);
const TEST_SESSION_ID = 'ask-user-test';

let disposables: DisposableStore;

function input(
  overrides: Partial<AskUserQuestionInput['questions'][number]> = {},
): AskUserQuestionInput {
  return {
    questions: [
      {
        question: 'Which database?',
        header: 'Storage',
        options: [
          { label: 'Postgres', description: 'Relational storage' },
          { label: 'SQLite', description: 'Embedded storage' },
        ],
        multi_select: false,
        ...overrides,
      },
    ],
  };
}

function makeTool(
  options: {
    readonly activeTaskTools?: ReadonlySet<string>;
    readonly request?: (
      req: QuestionRequest,
      requestOptions?: { readonly agentId?: string; readonly detached?: boolean },
    ) => Promise<QuestionResult>;
  } = {},
): {
  readonly tool: IAskUserQuestionTool;
  readonly request: ReturnType<typeof vi.fn>;
  readonly telemetryTrack: ReturnType<typeof vi.fn>;
  readonly registerTask: ReturnType<typeof vi.fn>;
  readonly getTask: ReturnType<typeof vi.fn>;
  readonly lastRegisteredTask: () => QuestionBackgroundTask | undefined;
} {
  const request = vi.fn(options.request ?? (async () => ({ Postgres: true }) as QuestionResult));
  const telemetryTrack = vi.fn();
  let lastTask: QuestionBackgroundTask | undefined;
  const registerTask = vi.fn((task: QuestionBackgroundTask) => {
    lastTask = task;
    return 'q_test_task_id';
  });
  const getTask = vi.fn(
    (id: string): QuestionTaskInfo | undefined =>
      id === 'q_test_task_id'
        ? {
            taskId: id,
            description: 'Which database?',
            status: 'running',
            detached: true,
            startedAt: 0,
            endedAt: null,
            kind: 'question',
            questionCount: 1,
            toolCallId: 'call_bg',
          }
        : undefined,
  );
  const activeTaskTools = options.activeTaskTools ?? TASK_TOOLS;
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.definePartialInstance(ISessionContext, { sessionId: TEST_SESSION_ID });
      reg.definePartialInstance(ITelemetryService, { track2: telemetryTrack });
      reg.definePartialInstance(IAgentTaskService, { registerTask, getTask });
      reg.definePartialInstance(IAgentScopeContext, { agentId: 'main' });
      reg.definePartialInstance(IAgentToolPolicyService, {
        isToolActive: (name: string) => activeTaskTools.has(name),
      });
      reg.define(IAskUserQuestionTool, AskUserQuestionTool);
    },
    strict: true,
  });
  const seen = new Set<string>();
  const answerNewPending = (): void => {
    for (const pending of interactions.findAll({
      kind: 'question',
      resolved: false,
      tags: { sessionId: TEST_SESSION_ID },
    })) {
      if (seen.has(pending.id)) continue;
      seen.add(pending.id);
      const agentId = pending.tags[INTERACTION_TAG_AGENT_ID];
      void request(pending.payload as QuestionRequest, {
        agentId: typeof agentId === 'string' ? agentId : 'main',
        detached: pending.tags[INTERACTION_TAG_TURN_ID] === undefined,
      }).then((result) => {
        interactions.respond(pending.id, result);
      });
    }
  };
  disposables.add(toDisposable(interactions.onDidChangePending(answerNewPending)));
  const tool = ix.get(IAskUserQuestionTool);
  return { tool, request, telemetryTrack, registerTask, getTask, lastRegisteredTask: () => lastTask };
}

describe('AskUserQuestionTool', () => {
  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    disposables.dispose();
    interactions.purgeSession(TEST_SESSION_ID);
  });

  it('exposes current metadata and schema', () => {
    const { tool } = makeTool();

    expect(tool.name).toBe('AskUserQuestion');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { questions: { type: 'array' } },
    });
    expect(AskUserQuestionInputSchema.safeParse(input()).success).toBe(true);
    expect(AskUserQuestionInputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(
      AskUserQuestionInputSchema.safeParse(
        input({
          options: [{ label: 'Only one', description: 'Not enough choices' }],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects empty question text and empty option labels at the schema layer', () => {
    expect(
      AskUserQuestionInputSchema.safeParse(input({ question: '' })).success,
    ).toBe(false);
    expect(
      AskUserQuestionInputSchema.safeParse(
        input({
          options: [
            { label: '', description: 'Empty label' },
            { label: 'B', description: '' },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('preserves foreground dismissal when background mode is unavailable', async () => {
    const { tool } = makeTool({
      activeTaskTools: new Set(),
      request: async () => null,
    });

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_fg_dismissed',
      args: input(),
      signal,
    });

    expect(result).toEqual({
      isError: false,
      output: JSON.stringify({
        answers: {},
        note: 'User dismissed the question without answering.',
      }),
    });
  });

  it('passes empty headers and option descriptions through verbatim (v1 wire parity)', async () => {
    const { tool, request } = makeTool();

    await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_empty_fields',
      args: input({
        header: '',
        options: [
          { label: 'Postgres', description: '' },
          { label: 'SQLite', description: '' },
        ],
      }),
      signal,
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            header: '',
            options: [
              { label: 'Postgres', description: '' },
              { label: 'SQLite', description: '' },
            ],
          }),
        ],
      }),
      { agentId: 'main', detached: false },
    );
  });

  it('merges the request trace id into question telemetry', async () => {
    const { tool, telemetryTrack } = makeTool();

    const result = await executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_question',
      args: input(),
      signal,
      trace: { traceId: 'trace-q-1' },
    });

    expect(result).toMatchObject({ isError: false });
    expect(telemetryTrack).toHaveBeenCalledWith('question_answered', {
      answered: 1,
      trace_id: 'trace-q-1',
    });
  });

  describe('background mode', () => {
    function makeSink(abortSignal?: AbortSignal) {
      const outputs: string[] = [];
      const settlements: Array<{ status: string; stopReason?: string }> = [];
      const sink = {
        signal: abortSignal ?? new AbortController().signal,
        appendOutput: (chunk: string) => {
          outputs.push(chunk);
        },
        settle: async (settlement: { status: string; stopReason?: string }) => {
          settlements.push(settlement);
          return true;
        },
      };
      return { sink, outputs, settlements };
    }

    it('detaches the background question from the asking turn', async () => {
      const { tool, request, lastRegisteredTask } = makeTool();
      await executeTool(tool, {
        turnId: 4,
        toolCallId: 'call_bg_detached',
        args: { ...input(), background: true },
        signal,
      });

      const { sink } = makeSink();
      await lastRegisteredTask()!.start(sink);

      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]![0]).toMatchObject({ turnId: 4, toolCallId: 'call_bg_detached' });
      expect(request.mock.calls[0]![1]).toMatchObject({ detached: true });

      await executeTool(tool, { turnId: 4, toolCallId: 'call_fg', args: input(), signal });

      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]![1]).not.toMatchObject({ detached: true });
    });
  });
});
