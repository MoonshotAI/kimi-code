import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Emitter,
  SyncDescriptor,
  type ApprovalRequest,
  type ApprovalResponse,
  type Event,
  type QuestionRequest,
  type QuestionResult,
} from '../../src';
import { TestInstantiationService } from '../../src/di/test';

import {
  CoreProcessService,
  IApprovalService,
  IEnvironmentService,
  IEventService,
  ILogService,
  IQuestionService,
} from '../../src/services';
import { ICoreProcessService, ICoreRuntime } from '../../src/services/coreProcess/coreProcess';

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
  async request(_req: ApprovalRequest & { sessionId: string; agentId: string }): Promise<ApprovalResponse> {
    return { decision: 'approved' };
  }
  resolve(_id: string, _response: ApprovalResponse): void {}
  listPending(): ReturnType<IApprovalService['listPending']> {
    return [];
  }
}

class RecordingQuestionService implements IQuestionService {
  readonly _serviceBrand: undefined;
  async request(_req: QuestionRequest & { sessionId: string; agentId: string }): Promise<QuestionResult> {
    return null;
  }
  resolve(_id: string, _response: QuestionResult): void {}
  dismiss(_id: string): void {}
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
  tmpHome = mkdtempSync(join(tmpdir(), 'kimi-core-runtime-test-'));
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

function makeEnv(homeDir: string): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir,
    configPath: join(homeDir, 'config.toml'),
  };
}

function makePeers() {
  return {
    eventService: new RecordingEventService(),
    approvalService: new RecordingApprovalService(),
    questionService: new RecordingQuestionService(),
    logService: new NoopLogService(),
  };
}

function buildService(ix: TestInstantiationService): CoreProcessService {
  const peers = makePeers();
  ix.stub(IEventService, peers.eventService);
  ix.stub(IApprovalService, peers.approvalService);
  ix.stub(IQuestionService, peers.questionService);
  ix.stub(IEnvironmentService, makeEnv(tmpHome));
  ix.stub(ILogService, peers.logService);
  return ix.createInstance(CoreProcessService, {});
}

describe('ICoreRuntime facade', () => {
  it('shares its decorator token with the deprecated ICoreProcessService alias', () => {
    // Both names point at the identical ServiceIdentifier object, keyed by
    // the canonical 'coreProcessService' decorator string.
    expect(ICoreRuntime).toBe(ICoreProcessService);
    expect(ICoreRuntime.toString()).toBe('coreProcessService');
    expect(ICoreProcessService.toString()).toBe('coreProcessService');
  });

  it('resolves the same singleton whether looked up via ICoreRuntime or ICoreProcessService', async () => {
    const ix = new TestInstantiationService();
    const peers = makePeers();
    ix.stub(IEventService, peers.eventService);
    ix.stub(IApprovalService, peers.approvalService);
    ix.stub(IQuestionService, peers.questionService);
    ix.stub(IEnvironmentService, makeEnv(tmpHome));
    ix.stub(ILogService, peers.logService);
    ix.set(ICoreRuntime, new SyncDescriptor(CoreProcessService, [{}]));

    try {
      const viaRuntime = ix.get(ICoreRuntime);
      const viaAlias = ix.get(ICoreProcessService);
      expect(viaRuntime).toBe(viaAlias);
      expect(viaRuntime).toBeInstanceOf(CoreProcessService);
      await expect(viaRuntime.ready()).resolves.toBeUndefined();
    } finally {
      ix.dispose();
    }
  });

  it('ready() resolves and dispose() is idempotent and short-circuits rpc dispatch', async () => {
    const ix = new TestInstantiationService();
    const core = buildService(ix);
    try {
      await expect(core.ready()).resolves.toBeUndefined();
      expect(typeof core.rpc.getCoreInfo).toBe('function');

      core.dispose();
      core.dispose(); // idempotent — second call is a no-op.

      await expect(core.rpc.getCoreInfo({})).rejects.toThrow(/disposed/);
    } finally {
      ix.dispose();
    }
  });

  it('getCoreApi() returns the in-process KimiCore and throws after dispose', async () => {
    const ix = new TestInstantiationService();
    const core = buildService(ix);
    try {
      await core.ready();

      const coreApi = core.getCoreApi();
      // The in-process handle exposes the CoreAPI methods directly (no RPC hop).
      expect(typeof coreApi.getCoreInfo).toBe('function');
      const info = await coreApi.getCoreInfo({});
      expect(info).toHaveProperty('version');
      expect(typeof info.version).toBe('string');

      // Repeated calls return the same underlying instance (no proxy wrapper).
      expect(core.getCoreApi()).toBe(coreApi);

      core.dispose();
      expect(() => core.getCoreApi()).toThrow(/disposed/);
    } finally {
      ix.dispose();
    }
  });
});
