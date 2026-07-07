import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SyncDescriptor,
  Emitter,
  getSingletonServiceDescriptors,
  type ApprovalRequest,
  type ApprovalResponse,
  type Event,
  type QuestionRequest,
  type QuestionResult,
} from '../../src';
import { TestInstantiationService } from '../../src/di/test';

import {
  BridgeClientAPI,
  CoreProcessService,
  IApprovalService,
  IEnvironmentService,
  IEventService,
  ILogService,
  ICoreProcessService,
  IQuestionService,
} from '../../src/services';

class RecordingEventService implements IEventService {
  readonly _serviceBrand: undefined;

  readonly events: Event[] = [];
  private readonly _emitter = new Emitter<Event>();
  readonly onDidPublish = this._emitter.event;
  publish(event: Event): void {
    this.events.push(event);
    this._emitter.fire(event);
  }
}

class RecordingApprovalService implements IApprovalService {
  readonly _serviceBrand: undefined;

  readonly received: ApprovalRequest[] = [];
  readonly resolveCalls: Array<{ id: string; response: ApprovalResponse }> = [];
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

class RecordingQuestionService implements IQuestionService {
  readonly _serviceBrand: undefined;

  readonly received: QuestionRequest[] = [];
  readonly resolveCalls: Array<{ id: string; response: QuestionResult }> = [];
  readonly dismissCalls: string[] = [];
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

class NoopLogService implements ILogService {
  readonly _serviceBrand: undefined;

  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogService {
    return this;
  }
}

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kimi-services-test-'));
  prevHome = process.env['KIMI_HOME'];
  process.env['KIMI_HOME'] = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env['KIMI_HOME'];
  } else {
    process.env['KIMI_HOME'] = prevHome;
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
  }
});

function makePeers() {
  return {
    eventService: new RecordingEventService(),
    approvalService: new RecordingApprovalService(),
    questionService: new RecordingQuestionService(),
    logService: new NoopLogService(),
  };
}

function makeEnv(homeDir: string): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir,
    configPath: join(homeDir, 'config.toml'),
  };
}

describe('BridgeClientAPI', () => {
  it('routes emitEvent / requestApproval / requestQuestion / toolCall to peer services', async () => {
    const { eventService, approvalService, questionService, logService } = makePeers();
    const api = new BridgeClientAPI({ eventService, approvalService, questionService, logService });

    const ev: Event = {
      type: 'agent_status_updated',
      sessionId: 'sess-1',
      agentId: 'main',
      status: { state: 'idle' },
    } as unknown as Event;
    api.emitEvent(ev);
    expect(eventService.events).toEqual([ev]);

    const approvalReq = {
      toolCallId: 'tc-1',
      toolName: 'shell.run',
      action: 'execute',
      display: { kind: 'generic', summary: 'do thing' } as ApprovalRequest['display'],
      sessionId: 'sess-1',
      agentId: 'main',
    };
    const approvalResp = await api.requestApproval(approvalReq);
    expect(approvalResp).toEqual({ decision: 'approved' });
    expect(approvalService.received).toHaveLength(1);

    const questionReq = {
      questions: [{ question: '?', options: [{ label: 'A' }] }],
      sessionId: 'sess-1',
      agentId: 'main',
    };
    const questionResp = await api.requestQuestion(questionReq);
    expect(questionResp).toBeNull();
    expect(questionService.received).toHaveLength(1);

    const toolResp = await api.toolCall({
      toolCallId: 'tc-2',
      args: {},
      sessionId: 'sess-1',
      agentId: 'main',
    });
    expect(toolResp.isError).toBe(true);
    expect(toolResp.output).toMatch(/SDK custom tool calls are not supported/);
  });
});

describe('CoreProcessService direct construction', () => {
  it('constructs, exposes a callable rpc proxy, and ready() resolves', async () => {
    const { eventService, approvalService, questionService, logService } = makePeers();
    const core = new CoreProcessService(
      {},
      makeEnv(tmpHome),
      eventService,
      approvalService,
      questionService,
      logService,
    );
    try {
      await expect(core.ready()).resolves.toBeUndefined();
      expect(typeof core.rpc.getCoreInfo).toBe('function');
    } finally {
      core.dispose();
    }
  });

  it('rpc round-trip through createRPC reaches KimiCore (getCoreInfo smoke)', async () => {
    const { eventService, approvalService, questionService, logService } = makePeers();
    const core = new CoreProcessService(
      {},
      makeEnv(tmpHome),
      eventService,
      approvalService,
      questionService,
      logService,
    );
    try {
      await core.ready();
      const info = await core.rpc.getCoreInfo({});
      expect(info).toHaveProperty('version');
      expect(typeof info.version).toBe('string');
    } finally {
      core.dispose();
    }
  });

  it('dispose is idempotent and short-circuits subsequent rpc calls', async () => {
    const { eventService, approvalService, questionService, logService } = makePeers();
    const core = new CoreProcessService(
      {},
      makeEnv(tmpHome),
      eventService,
      approvalService,
      questionService,
      logService,
    );
    await core.ready();
    core.dispose();
    core.dispose();

    await expect(core.rpc.getCoreInfo({})).rejects.toThrow(/disposed/);
  });

  it('default-wires a resolveOAuthTokenProvider when caller omits one', () => {
    const resolver = CoreProcessService._defaultOAuthTokenResolver(tmpHome, join(tmpHome, 'config.toml'));
    expect(typeof resolver).toBe('function');
    const tokenProvider = resolver('managed:kimi-code');
    expect(tokenProvider).toBeDefined();
    expect(typeof tokenProvider?.getAccessToken).toBe('function');
  });

  it('default-wires kimiRequestHeaders from identity when caller omits headers', () => {
    const headers = CoreProcessService._defaultKimiRequestHeaders(
      tmpHome,
      { userAgentProduct: 'kimi-code-cli', version: '9.9.9' },
    );
    expect(headers).toBeDefined();
    expect(headers!['User-Agent']).toMatch(/^kimi-code-cli\/9\.9\.9/);
    expect(headers!['X-Msh-Platform']).toBe('kimi_code_cli');
    expect(headers!['X-Msh-Version']).toBe('9.9.9');
    expect(headers!['X-Msh-Device-Id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns undefined headers when no identity is provided (back-compat)', () => {
    const headers = CoreProcessService._defaultKimiRequestHeaders(tmpHome);
    expect(headers).toBeUndefined();
  });

  it('caller-supplied kimiRequestHeaders win over identity-derived defaults', () => {
    const explicit = { 'User-Agent': 'override/1.0' };
    const picked =
      explicit ?? CoreProcessService._defaultKimiRequestHeaders(
        tmpHome,
        { userAgentProduct: 'kimi-code-cli', version: '9.9.9' },
      );
    expect(picked).toBe(explicit);
  });
});

describe('singleton registry composition', () => {
  it('returns a CoreProcessService descriptor that composes with the DI container', async () => {
    const { eventService, approvalService, questionService } = makePeers();
    const moduleEntries = getSingletonServiceDescriptors();
    expect(moduleEntries.length).toBeGreaterThanOrEqual(1);
    expect(moduleEntries[0]![0]).toBe(ICoreProcessService);
    expect(moduleEntries[0]![1]).toBeInstanceOf(SyncDescriptor);

    const ix = new TestInstantiationService();
    for (const [id, desc] of moduleEntries) {
      ix.set(id, desc);
    }
    ix.stub(IEventService, eventService);
    ix.stub(IApprovalService, approvalService);
    ix.stub(IQuestionService, questionService);
    ix.stub(IEnvironmentService, makeEnv(tmpHome));
    ix.stub(ILogService, new NoopLogService());

    try {
      const core = ix.createInstance(CoreProcessService, {});
      try {
        await core.ready();
        expect(typeof core.rpc.getCoreInfo).toBe('function');
      } finally {
        core.dispose();
      }
    } finally {
      ix.dispose();
    }
  });
});
