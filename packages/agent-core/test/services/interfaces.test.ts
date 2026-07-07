import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  Emitter,
} from '../../src';
import { TestInstantiationService } from '../../src/di/test';
import type { ApprovalRequest, Event, QuestionRequest } from '../../src';

import {
  IApprovalService,
  IEventService,
  IFileStore,
  IFsGitService,
  IFsSearchService,
  IFsService,
  IFsWatcher,
  ILogService,
  IQuestionService,
  IWorkspaceFsService,
  IWorkspaceRegistry,
  FileStore,
  FsGitService,
  FsSearchService,
  FsService,
  FsWatcherService,
  WorkspaceFsService,
  WorkspaceRegistryService,
  parsePorcelain,
  resolveSafePath,
  type ApprovalResponse,
  type QuestionResult,
} from '../../src/services';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const sdkPackageName = ['@moonshot-ai', 'kimi-code-sdk'].join('/');

function readPackageFiles(): string {
  const files = [
    'package.json',
    'tsdown.config.ts',
    'vitest.config.ts',
    ...sourceFiles(join(packageRoot, 'src')),
  ];
  return files
    .map((file) => readFileSync(join(packageRoot, file), 'utf8'))
    .join('\n');
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(relative(packageRoot, full));
    }
  }
  return files;
}

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
  listPending(): ReturnType<IApprovalService['listPending']> {
    return [];
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
  listPending(): ReturnType<IQuestionService['listPending']> {
    return [];
  }
}

function makeFakeEvent(): Event {
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

describe('@moonshot-ai/agent-core · services interfaces', () => {
  it('does not depend on the node SDK package', () => {
    expect(readPackageFiles()).not.toContain(sdkPackageName);
  });

  it('registers all three peer services in a test instantiation service', () => {
    const events = new FakeEventService();
    const approvals = new FakeApprovalService();
    const questions = new FakeQuestionService();

    const ix = new TestInstantiationService();
    ix.stub(IEventService, events);
    ix.stub(IApprovalService, approvals);
    ix.stub(IQuestionService, questions);

    expect(ix.get(IEventService)).toBe(events);
    expect(ix.get(IApprovalService)).toBe(approvals);
    expect(ix.get(IQuestionService)).toBe(questions);
  });

  it('end-to-end smoke: invokes service methods through the test container', async () => {
    const events = new FakeEventService();
    const approvals = new FakeApprovalService();
    const questions = new FakeQuestionService();

    const ix = new TestInstantiationService();
    ix.stub(IEventService, events);
    ix.stub(IApprovalService, approvals);
    ix.stub(IQuestionService, questions);

    const event = makeFakeEvent();
    ix.get(IEventService).publish(event);
    expect(events.events).toEqual([event]);

    const approval = makeFakeApproval();
    const approvalResp = await ix.get(IApprovalService).request(approval);
    expect(approvalResp).toEqual({ decision: 'approved' });
    expect(approvals.received).toHaveLength(1);

    const question = makeFakeQuestion();
    const questionResp = await ix.get(IQuestionService).request(question);
    expect(questionResp).toBeNull();
    expect(questions.received).toHaveLength(1);
  });

  it('resolve/dismiss service methods are wired through the same DI value', () => {
    const approvals = new FakeApprovalService();
    const questions = new FakeQuestionService();

    const ix = new TestInstantiationService();
    ix.stub(IApprovalService, approvals);
    ix.stub(IQuestionService, questions);

    ix.get(IApprovalService).resolve('tc-1', { decision: 'rejected', feedback: 'no' });
    ix.get(IQuestionService).resolve('q-1', { answers: { q_1: 'A' } });
    ix.get(IQuestionService).dismiss('q-2');

    expect(approvals.resolveCalls).toEqual([
      { id: 'tc-1', response: { decision: 'rejected', feedback: 'no' } },
    ]);
    expect(questions.resolveCalls).toEqual([
      { id: 'q-1', response: { answers: { q_1: 'A' } } },
    ]);
    expect(questions.dismissCalls).toEqual(['q-2']);
  });

  it('looking up an unregistered service returns undefined in non-strict mode', () => {
    const ix = new TestInstantiationService();
    expect(ix.get(IEventService)).toBeUndefined();
    expect(ix.get(IApprovalService)).toBeUndefined();
    expect(ix.get(IQuestionService)).toBeUndefined();
  });

  it('IEventService / IApprovalService / IQuestionService are callable ServiceIdentifiers (compile-time guard)', () => {
    expect(typeof IEventService).toBe('function');
    expect(typeof IApprovalService).toBe('function');
    expect(typeof IQuestionService).toBe('function');

    const _typeProbe: ApprovalResponse | QuestionResult = null;
    void _typeProbe;
    vi.fn();
  });

  it('exports filesystem, file store, logger, and workspace service surfaces from the services package', () => {
    expect(typeof ILogService).toBe('function');
    expect(typeof IFileStore).toBe('function');
    expect(typeof IFsService).toBe('function');
    expect(typeof IFsSearchService).toBe('function');
    expect(typeof IFsGitService).toBe('function');
    expect(typeof IFsWatcher).toBe('function');
    expect(typeof IWorkspaceRegistry).toBe('function');
    expect(typeof IWorkspaceFsService).toBe('function');

    expect(typeof FileStore).toBe('function');
    expect(typeof FsService).toBe('function');
    expect(typeof FsSearchService).toBe('function');
    expect(typeof FsGitService).toBe('function');
    expect(typeof FsWatcherService).toBe('function');
    expect(typeof WorkspaceRegistryService).toBe('function');
    expect(typeof WorkspaceFsService).toBe('function');
    expect(typeof parsePorcelain).toBe('function');
    expect(typeof resolveSafePath).toBe('function');
  });
});
