/**
 * W3.2 acceptance: HarnessBridge wires brokers + KimiCore + RPC pair; ready()
 * settles; dispose() short-circuits RPC; defaultServicesModule() composes with
 * the DI container.
 *
 * Hermetic strategy: KimiCore wants a real HOME dir / config / Git Bash. We
 * point it at an isolated tmp dir per test so it doesn't touch the user's
 * `~/.kimi`. The bridge's RPC smoke uses a single round-trip
 * (`getCoreInfo`) that doesn't require any external state — exercises the
 * full RPC plumbing (core ← createRPC → bridgeClientAPI binding) without
 * touching session/plugin/MCP code paths. createSession() smoke is harder
 * to make hermetic because it spins up Kaos, hooks, and plugin discovery —
 * we leave that to W4+ when daemon-side mocks land.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
  type ApprovalRequest,
  type ApprovalResponse,
  type Event,
  type QuestionRequest,
  type QuestionResult,
} from '@moonshot-ai/agent-core';

import {
  BridgeClientAPI,
  HarnessBridge,
  IApprovalBroker,
  IEventBus,
  IHarnessBridge,
  IQuestionBroker,
  defaultServicesModule,
} from '../src';

// --- Mock broker impls (per-test fresh instances) ----------------------------

class RecordingEventBus implements IEventBus {
  readonly events: Event[] = [];
  publish(event: Event): void {
    this.events.push(event);
  }
}

class RecordingApprovalBroker implements IApprovalBroker {
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

class RecordingQuestionBroker implements IQuestionBroker {
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

function makeBrokers() {
  return {
    eventBus: new RecordingEventBus(),
    approvalBroker: new RecordingApprovalBroker(),
    questionBroker: new RecordingQuestionBroker(),
  };
}

// --- Tests -------------------------------------------------------------------

describe('BridgeClientAPI (W3.2)', () => {
  it('routes emitEvent / requestApproval / requestQuestion / toolCall to brokers', async () => {
    const { eventBus, approvalBroker, questionBroker } = makeBrokers();
    const api = new BridgeClientAPI({ eventBus, approvalBroker, questionBroker });

    const ev: Event = {
      type: 'agent_status_updated',
      sessionId: 'sess-1',
      agentId: 'main',
      status: { state: 'idle' },
    } as unknown as Event;
    api.emitEvent(ev);
    expect(eventBus.events).toEqual([ev]);

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
    expect(approvalBroker.received).toHaveLength(1);

    const questionReq = {
      questions: [{ question: '?', options: [{ label: 'A' }] }],
      sessionId: 'sess-1',
      agentId: 'main',
    };
    const questionResp = await api.requestQuestion(questionReq);
    expect(questionResp).toBeNull();
    expect(questionBroker.received).toHaveLength(1);

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

describe('HarnessBridge direct construction (W3.2)', () => {
  it('constructs, exposes a callable rpc proxy, and ready() resolves', async () => {
    const { eventBus, approvalBroker, questionBroker } = makeBrokers();
    const bridge = new HarnessBridge({ homeDir: tmpHome }, eventBus, approvalBroker, questionBroker);
    try {
      // ready() resolves once the SDK side of the RPC pair has bound.
      await expect(bridge.ready()).resolves.toBeUndefined();
      expect(typeof bridge.rpc.getCoreInfo).toBe('function');
    } finally {
      bridge.dispose();
    }
  });

  it('rpc round-trip through createRPC reaches KimiCore (getCoreInfo smoke)', async () => {
    const { eventBus, approvalBroker, questionBroker } = makeBrokers();
    const bridge = new HarnessBridge({ homeDir: tmpHome }, eventBus, approvalBroker, questionBroker);
    try {
      await bridge.ready();
      // getCoreInfo is a pure read on KimiCore (no session/plugin state). It
      // round-trips through the full createRPC pair (serialize → core →
      // serialize back) — that's the bridge smoke we care about.
      const info = await bridge.rpc.getCoreInfo({});
      expect(info).toHaveProperty('version');
      expect(typeof info.version).toBe('string');
    } finally {
      bridge.dispose();
    }
  });

  it('dispose is idempotent and short-circuits subsequent rpc calls', async () => {
    const { eventBus, approvalBroker, questionBroker } = makeBrokers();
    const bridge = new HarnessBridge({ homeDir: tmpHome }, eventBus, approvalBroker, questionBroker);
    await bridge.ready();
    bridge.dispose();
    bridge.dispose(); // second call must be a no-op

    await expect(bridge.rpc.getCoreInfo({})).rejects.toThrow(/disposed/);
  });

  // Regression: prior to the BLOCKER fix the bridge never forwarded a
  // `resolveOAuthTokenProvider` into KimiCore. ProviderManager.resolveAuth
  // then synthesized a closure that ALWAYS threw `auth.login_required`
  // even after a successful device-code login. The daemon's `/auth`
  // readiness probe (file-existence check) still said `ready:true`, so the
  // failure only surfaced inside the prompt turn. Lock down that the
  // bridge default-wires a resolver from the same home/config paths
  // KimiCore consumes.
  it('default-wires a resolveOAuthTokenProvider when caller omits one', () => {
    const resolver = HarnessBridge._defaultOAuthTokenResolver({ homeDir: tmpHome });
    expect(typeof resolver).toBe('function');
    // Calling the resolver with the managed-kimi-code provider name must
    // return an object exposing `getAccessToken`. We don't invoke it —
    // there's no token on disk in this hermetic test — but the shape is
    // sufficient to prove the bridge wired a real BearerTokenProvider
    // factory (not the always-throw sentinel).
    const tokenProvider = resolver('managed:kimi-code');
    expect(tokenProvider).toBeDefined();
    expect(typeof tokenProvider?.getAccessToken).toBe('function');
  });
});

describe('defaultServicesModule() composition (W3.2)', () => {
  it('returns a HarnessBridge descriptor that composes with the DI container', async () => {
    const { eventBus, approvalBroker, questionBroker } = makeBrokers();
    const moduleEntries = defaultServicesModule();
    // W6.2 added ISessionService; the array grows as Chains land. We assert
    // IHarnessBridge is the FIRST entry (its position matters because the
    // daemon's start.ts uses createInstance + services.set on top of the
    // descriptor — the order documents the canonical construction sequence).
    expect(moduleEntries.length).toBeGreaterThanOrEqual(1);
    expect(moduleEntries[0]![0]).toBe(IHarnessBridge);
    expect(moduleEntries[0]![1]).toBeInstanceOf(SyncDescriptor);

    const services = new ServiceCollection(
      [IEventBus, eventBus],
      [IApprovalBroker, approvalBroker],
      [IQuestionBroker, questionBroker],
      // Spread module entries — the W2 ServiceCollection ctor accepts
      // `ReadonlyArray<readonly [id, value]>`. We use the descriptor as the
      // "value" so the container constructs it lazily; HarnessBridge ctor's
      // first three args (eventBus/approvalBroker/questionBroker) come from
      // the static-arguments slot only when SyncDescriptor passes them, but
      // for the direct-construction case below we use createInstance.
      ...moduleEntries.map(([id, desc]) => [id, desc] as const),
    );
    const ix = new InstantiationService(services);

    try {
      // createInstance with explicit ctor-arg passthrough (W2 has no ctor-arg
      // DI injection yet; see W2 README + handoff notes). We pull the brokers
      // out of the accessor and hand them to the ctor literally.
      const bridge = ix.invokeFunction((a) => {
        return ix.createInstance(
          HarnessBridge,
          a.get(IEventBus),
          a.get(IApprovalBroker),
          a.get(IQuestionBroker),
          { homeDir: tmpHome },
        );
      });
      try {
        await bridge.ready();
        expect(typeof bridge.rpc.getCoreInfo).toBe('function');
      } finally {
        bridge.dispose();
      }
    } finally {
      ix.dispose();
    }
  });
});
