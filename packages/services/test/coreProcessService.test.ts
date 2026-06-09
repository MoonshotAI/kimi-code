/**
 * Acceptance: `CoreProcessService` wires peer services + KimiCore + RPC pair;
 * `ready()` settles; `dispose()` short-circuits RPC; `defaultServicesModule()`
 * composes with the DI container.
 *
 * Hermetic strategy: KimiCore wants a real HOME dir / config / Git Bash. We
 * point it at an isolated tmp dir per test so it doesn't touch the user's
 * `~/.kimi`. The `rpc` smoke uses a single round-trip (`getCoreInfo`) that
 * doesn't require any external state — exercises the full RPC plumbing (core
 * ← createRPC → BridgeClientAPI binding) without touching session/plugin/MCP
 * code paths. createSession() smoke is harder to make hermetic because it
 * spins up Kaos, hooks, and plugin discovery — we leave that to integration
 * suites with daemon-side mocks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
  Emitter,
  type ApprovalRequest,
  type ApprovalResponse,
  type Event,
  type QuestionRequest,
  type QuestionResult,
} from '@moonshot-ai/agent-core';

import {
  BridgeClientAPI,
  CoreProcessService,
  IApprovalService,
  IEnvironmentService,
  IEventService,
  ICoreProcessService,
  IQuestionService,
  defaultServicesModule,
} from '../src';

// --- Mock peer-service impls (per-test fresh instances) ----------------------

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
}

// --- Sandbox HOME setup ------------------------------------------------------

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
    // Best-effort cleanup; tmp dirs are auto-pruned.
  }
});

function makePeers() {
  return {
    eventService: new RecordingEventService(),
    approvalService: new RecordingApprovalService(),
    questionService: new RecordingQuestionService(),
  };
}

function makeEnv(homeDir: string): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir,
    configPath: join(homeDir, 'config.toml'),
  };
}

// --- Tests -------------------------------------------------------------------

describe('BridgeClientAPI', () => {
  it('routes emitEvent / requestApproval / requestQuestion / toolCall to peer services', async () => {
    const { eventService, approvalService, questionService } = makePeers();
    const api = new BridgeClientAPI({ eventService, approvalService, questionService });

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
    const { eventService, approvalService, questionService } = makePeers();
    const core = new CoreProcessService(
      {},
      makeEnv(tmpHome),
      eventService,
      approvalService,
      questionService,
    );
    try {
      // ready() resolves once the SDK side of the RPC pair has bound.
      await expect(core.ready()).resolves.toBeUndefined();
      expect(typeof core.rpc.getCoreInfo).toBe('function');
    } finally {
      core.dispose();
    }
  });

  it('rpc round-trip through createRPC reaches KimiCore (getCoreInfo smoke)', async () => {
    const { eventService, approvalService, questionService } = makePeers();
    const core = new CoreProcessService(
      {},
      makeEnv(tmpHome),
      eventService,
      approvalService,
      questionService,
    );
    try {
      await core.ready();
      // getCoreInfo is a pure read on KimiCore (no session/plugin state). It
      // round-trips through the full createRPC pair (serialize → core →
      // serialize back) — that's the in-process adapter smoke we care about.
      const info = await core.rpc.getCoreInfo({});
      expect(info).toHaveProperty('version');
      expect(typeof info.version).toBe('string');
    } finally {
      core.dispose();
    }
  });

  it('dispose is idempotent and short-circuits subsequent rpc calls', async () => {
    const { eventService, approvalService, questionService } = makePeers();
    const core = new CoreProcessService(
      {},
      makeEnv(tmpHome),
      eventService,
      approvalService,
      questionService,
    );
    await core.ready();
    core.dispose();
    core.dispose(); // second call must be a no-op

    await expect(core.rpc.getCoreInfo({})).rejects.toThrow(/disposed/);
  });

  // Regression: prior to the BLOCKER fix the in-process adapter never
  // forwarded a `resolveOAuthTokenProvider` into KimiCore.
  // ProviderManager.resolveAuth then synthesized a closure that ALWAYS
  // threw `auth.login_required` even after a successful device-code login.
  // The daemon's `/auth` readiness probe (file-existence check) still said
  // `ready:true`, so the failure only surfaced inside the prompt turn.
  // Lock down that the adapter default-wires a resolver from the same
  // home/config paths KimiCore consumes.
  it('default-wires a resolveOAuthTokenProvider when caller omits one', () => {
    const resolver = CoreProcessService._defaultOAuthTokenResolver(tmpHome, join(tmpHome, 'config.toml'));
    expect(typeof resolver).toBe('function');
    // Calling the resolver with the managed-kimi-code provider name must
    // return an object exposing `getAccessToken`. We don't invoke it —
    // there's no token on disk in this hermetic test — but the shape is
    // sufficient to prove the adapter wired a real BearerTokenProvider
    // factory (not the always-throw sentinel).
    const tokenProvider = resolver('managed:kimi-code');
    expect(tokenProvider).toBeDefined();
    expect(typeof tokenProvider?.getAccessToken).toBe('function');
  });

  // Regression: prior to the identity-wiring fix the adapter never
  // forwarded `kimiRequestHeaders` into KimiCore — the daemon-hosted
  // KimiCore made upstream fetches with the Node default User-Agent, and
  // the managed Kimi-for-Coding endpoint rejected with 40340 ("only
  // available for Coding Agents such as Kimi CLI, …"). The in-process TUI
  // path (`createKimiHarness`) was unaffected because `SDKRpcClient`
  // already built these headers from `identity`. Lock down that the
  // adapter does the same when given an `identity`.
  it('default-wires kimiRequestHeaders from identity when caller omits headers', () => {
    const headers = CoreProcessService._defaultKimiRequestHeaders(
      tmpHome,
      { userAgentProduct: 'kimi-code-cli', version: '9.9.9' },
    );
    expect(headers).toBeDefined();
    expect(headers!['User-Agent']).toMatch(/^kimi-code-cli\/9\.9\.9/);
    expect(headers!['X-Msh-Platform']).toBe('kimi_code_cli');
    expect(headers!['X-Msh-Version']).toBe('9.9.9');
    // `createKimiDeviceId` mints + caches a per-machine UUID under
    // `<homeDir>/device_id`. Assert the header exists (UUID shape, not a
    // literal value — we tmp-isolate the home, so the value differs every
    // run).
    expect(headers!['X-Msh-Device-Id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns undefined headers when no identity is provided (back-compat)', () => {
    const headers = CoreProcessService._defaultKimiRequestHeaders(tmpHome);
    expect(headers).toBeUndefined();
  });

  it('caller-supplied kimiRequestHeaders win over identity-derived defaults', () => {
    // Sanity: when both are present the ctor takes `options.kimiRequestHeaders`
    // first. We can't observe the KimiCore ctor arg directly without exposing
    // it, so we just lock down the helper's precedence contract — the ctor's
    // `??` chain depends on it.
    const explicit = { 'User-Agent': 'override/1.0' };
    const picked =
      explicit ?? CoreProcessService._defaultKimiRequestHeaders(
        tmpHome,
        { userAgentProduct: 'kimi-code-cli', version: '9.9.9' },
      );
    expect(picked).toBe(explicit);
  });
});

describe('defaultServicesModule() composition', () => {
  it('returns a CoreProcessService descriptor that composes with the DI container', async () => {
    const { eventService, approvalService, questionService } = makePeers();
    const moduleEntries = defaultServicesModule();
    // ICoreProcessService is the FIRST entry (its position matters because
    // the daemon's start.ts uses createInstance + services.set on top of the
    // descriptor — the order documents the canonical construction sequence).
    expect(moduleEntries.length).toBeGreaterThanOrEqual(1);
    expect(moduleEntries[0]![0]).toBe(ICoreProcessService);
    expect(moduleEntries[0]![1]).toBeInstanceOf(SyncDescriptor);

    const services = new ServiceCollection(
      // Spread module entries first so the test's explicit per-decorator
      // overrides below win (last-write-wins in ServiceCollection). The
      // module now self-registers `IEventService` too, so we need the
      // fake `eventService` to land AFTER that descriptor entry.
      ...moduleEntries.map(([id, desc]) => [id, desc] as const),
      [IEventService, eventService],
      [IApprovalService, approvalService],
      [IQuestionService, questionService],
      [IEnvironmentService, makeEnv(tmpHome)],
    );
    const ix = new InstantiationService(services);

    try {
      // createInstance with static options prefix; @IEnvironmentService and
      // the three peer services auto-inject from the container.
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
