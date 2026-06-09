/**
 * Acceptance: the three peer-service decorators (`IEventService`,
 * `IApprovalService`, `IQuestionService`) are typed correctly, can be
 * registered in a `ServiceCollection`, resolved through
 * `InstantiationService`, and surface their diagnostic names in
 * not-registered errors.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  InstantiationService,
  ServiceCollection,
  Emitter,
} from '@moonshot-ai/agent-core';
import type { ApprovalRequest, Event, QuestionRequest } from '@moonshot-ai/agent-core';

import {
  IApprovalService,
  IEventService,
  IQuestionService,
  type ApprovalResponse,
  type QuestionResult,
} from '../src';

class FakeEventService implements IEventService {
  readonly _serviceBrand: undefined;

  readonly events: Event[] = [];
  private readonly _emitter = new Emitter<Event>();
  readonly onDidPublish = this._emitter.event;
  publish(event: Event): void {
    this.events.push(event);
    this._emitter.fire(event);
  }
}

class FakeApprovalService implements IApprovalService {
  readonly _serviceBrand: undefined;

  readonly received: ApprovalRequest[] = [];
  resolveCalls: Array<{ id: string; response: ApprovalResponse }> = [];
  async request(
    req: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    this.received.push(req);
    return { decision: 'approved' };
  }
  resolve(id: string, response: ApprovalResponse): void {
    this.resolveCalls.push({ id, response });
  }
}

class FakeQuestionService implements IQuestionService {
  readonly _serviceBrand: undefined;

  readonly received: QuestionRequest[] = [];
  resolveCalls: Array<{ id: string; response: QuestionResult }> = [];
  dismissCalls: string[] = [];
  async request(
    req: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    this.received.push(req);
    return null;
  }
  resolve(id: string, response: QuestionResult): void {
    this.resolveCalls.push({ id, response });
  }
  dismiss(id: string): void {
    this.dismissCalls.push(id);
  }
}

function makeFakeEvent(): Event {
  // Minimal AgentStatusUpdatedEvent shape — the union narrows by `type`.
  return {
    type: 'agent_status_updated',
    sessionId: 'sess-1',
    agentId: 'main',
    status: { state: 'idle' },
  } as unknown as Event;
}

function makeFakeApproval(): ApprovalRequest & { sessionId: string; agentId: string } {
  return {
    toolCallId: 'tc-1',
    toolName: 'shell.run',
    action: 'execute',
    display: { kind: 'generic', summary: 'do thing' } as ApprovalRequest['display'],
    sessionId: 'sess-1',
    agentId: 'main',
  };
}

function makeFakeQuestion(): QuestionRequest & { sessionId: string; agentId: string } {
  return {
    questions: [
      {
        question: 'Which?',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
    sessionId: 'sess-1',
    agentId: 'main',
  };
}

describe('@moonshot-ai/services · interfaces', () => {
  it('registers all three peer services in a ServiceCollection and resolves them through InstantiationService', () => {
    const events = new FakeEventService();
    const approvals = new FakeApprovalService();
    const questions = new FakeQuestionService();

    const services = new ServiceCollection(
      [IEventService, events],
      [IApprovalService, approvals],
      [IQuestionService, questions],
    );
    const ix = new InstantiationService(services);

    try {
      ix.invokeFunction((accessor) => {
        expect(accessor.get(IEventService)).toBe(events);
        expect(accessor.get(IApprovalService)).toBe(approvals);
        expect(accessor.get(IQuestionService)).toBe(questions);
      });
    } finally {
      ix.dispose();
    }
  });

  it('end-to-end smoke: invokes service methods via the accessor', async () => {
    const events = new FakeEventService();
    const approvals = new FakeApprovalService();
    const questions = new FakeQuestionService();

    const services = new ServiceCollection(
      [IEventService, events],
      [IApprovalService, approvals],
      [IQuestionService, questions],
    );
    const ix = new InstantiationService(services);

    try {
      const event = makeFakeEvent();
      ix.invokeFunction((a) => a.get(IEventService).publish(event));
      expect(events.events).toEqual([event]);

      const approval = makeFakeApproval();
      const approvalResp = await ix.invokeFunction((a) =>
        a.get(IApprovalService).request(approval),
      );
      expect(approvalResp).toEqual({ decision: 'approved' });
      expect(approvals.received).toHaveLength(1);

      const question = makeFakeQuestion();
      const questionResp = await ix.invokeFunction((a) =>
        a.get(IQuestionService).request(question),
      );
      expect(questionResp).toBeNull();
      expect(questions.received).toHaveLength(1);
    } finally {
      ix.dispose();
    }
  });

  it('resolve/dismiss service methods are wired through the same DI value', () => {
    const approvals = new FakeApprovalService();
    const questions = new FakeQuestionService();

    const services = new ServiceCollection(
      [IApprovalService, approvals],
      [IQuestionService, questions],
    );
    const ix = new InstantiationService(services);

    try {
      ix.invokeFunction((a) => {
        a.get(IApprovalService).resolve('tc-1', { decision: 'rejected', feedback: 'no' });
        a.get(IQuestionService).resolve('q-1', { answers: { q_1: 'A' } });
        a.get(IQuestionService).dismiss('q-2');
      });

      expect(approvals.resolveCalls).toEqual([
        { id: 'tc-1', response: { decision: 'rejected', feedback: 'no' } },
      ]);
      expect(questions.resolveCalls).toEqual([
        { id: 'q-1', response: { answers: { q_1: 'A' } } },
      ]);
      expect(questions.dismissCalls).toEqual(['q-2']);
    } finally {
      ix.dispose();
    }
  });

  it('looking up an unregistered service throws with the decorator diagnostic name', () => {
    const ix = new InstantiationService(new ServiceCollection());
    try {
      expect(() => ix.invokeFunction((a) => a.get(IEventService))).toThrow(/eventService/);
      expect(() => ix.invokeFunction((a) => a.get(IApprovalService))).toThrow(/approvalService/);
      expect(() => ix.invokeFunction((a) => a.get(IQuestionService))).toThrow(/questionService/);
    } finally {
      ix.dispose();
    }
  });

  it('IEventService / IApprovalService / IQuestionService are callable ServiceIdentifiers (compile-time guard)', () => {
    // The const half of the dual export must be usable as a ServiceCollection
    // key and as a `createDecorator` brand value. We exercise both at runtime
    // to also catch any accidental swap of the value with the type.
    expect(typeof IEventService).toBe('function');
    expect(typeof IApprovalService).toBe('function');
    expect(typeof IQuestionService).toBe('function');

    // Avoid an unused-import warning on the type-only re-export.
    const _typeProbe: ApprovalResponse | QuestionResult = null;
    void _typeProbe;
    // And use vi to keep the import surface (helpful when running with strict
    // unused-imports lints in the future).
    vi.fn();
  });
});
