/**
 * Approval end-to-end tests (W8.1 / Chain 5 / P1.5).
 *
 * Covers the reverse-RPC path: agent-core → BridgeClientAPI.requestApproval
 * → IApprovalService.request → WS `event.approval.requested` → REST
 * `POST /api/v1/sessions/{sid}/approvals/{aid}` → Promise resolves with agent-core
 * `ApprovalResponse`.
 *
 * **Bootstrap strategy** (mirrors prompt.e2e.test.ts): spawn the real daemon,
 * skip the `bridge.rpc.prompt(...)` path (requires provider creds), and drive
 * the broker DIRECTLY via the DI accessor. This exercises:
 *   - Adapter (in-process SDK shape → snake_case wire shape)
 *   - WS broadcast through `IEventService.publish` → subscriber receives frame
 *     with `payload.approval_id` + 12-arm `tool_input_display` preserved
 *   - REST `POST` resolves → broker Promise settles → response converts back
 *     to in-process SDK shape
 *   - Idempotency (40902) + not-found (40404)
 *   - 60s timeout (override to 30ms) broadcasts `event.approval.expired` AND
 *     rejects the Promise with `ApprovalExpiredError`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  IApprovalService,
  type ApprovalRequest,
  type ApprovalResponse,
} from '@moonshot-ai/services';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';
import {
  ApprovalExpiredError,
  ApprovalService,
} from '#/services/approval/approvalService';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-approvals-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-approvals-home-'));
});

afterEach(async () => {
  try {
    await daemon?.close();
  } catch {
    // ignore
  }
  daemon = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningDaemon> {
  daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
  });
  return daemon;
}

function appOf(r: RunningDaemon): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

async function createSession(r: RunningDaemon): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

async function openSubscriber(
  r: RunningDaemon,
  sid: string,
): Promise<{
  ws: WebSocket;
  received: Record<string, unknown>[];
}> {
  const wsUrl = r.address.replace('http://', 'ws://') + '/api/v1/ws';
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    sock.on('message', (data) => {
      try {
        received.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
  await waitFor(received, (f) => f['type'] === 'server_hello');
  ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'test', subscriptions: [sid] },
    }),
  );
  await waitFor(received, (f) => f['type'] === 'ack' && f['id'] === 'h1');
  return { ws, received };
}

async function waitFor(
  received: Record<string, unknown>[],
  pred: (f: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = received.find(pred);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `waitFor timed out; received: ${received.map((f) => f['type']).join(', ')}`,
  );
}

function firstPendingApprovalId(broker: ApprovalService): string | undefined {
  return (broker as unknown as {
    _pending: Map<string, { approvalId: string }>;
  })._pending.values().next().value?.approvalId;
}

// --- Tests -----------------------------------------------------------------

describe('Approval reverse-RPC: WS broadcast → REST resolve → Promise settle (W8.1)', () => {
  it('full happy path: broker request → WS event.approval.requested → REST POST → Promise resolves', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const broker = r.services.invokeFunction(
      (a) => a.get(IApprovalService) as ApprovalService,
    );

    const inProcReq: ApprovalRequest = {
      turnId: 11,
      toolCallId: 'tc_approval_happy',
      toolName: 'shell.run',
      action: 'Run `ls`',
      display: { kind: 'command', command: 'ls', summary: 'ls' } as never,
    };

    const pending = broker.request({
      ...inProcReq,
      sessionId: sid,
      agentId: 'main',
    });

    // Wait for the WS event.
    const requested = await waitFor(
      received,
      (f) => f['type'] === 'event.approval.requested',
      2000,
    );
    const payload = requested['payload'] as {
      approval_id: string;
      session_id: string;
      tool_call_id: string;
      tool_name: string;
      action: string;
      tool_input_display: { kind: string; command: string; summary: string };
      created_at: string;
      expires_at: string;
    };
    expect(payload.approval_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(payload.session_id).toBe(sid);
    expect(payload.tool_call_id).toBe('tc_approval_happy');
    expect(payload.tool_name).toBe('shell.run');
    expect(payload.action).toBe('Run `ls`');
    // 12-arm passthrough: snake_case `tool_input_display` preserves the
    // entire SDK shape unchanged.
    expect(payload.tool_input_display).toEqual({
      kind: 'command',
      command: 'ls',
      summary: 'ls',
    });
    expect(payload.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // REST resolve.
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/approvals/${payload.approval_id}`,
      payload: {
        decision: 'approved',
        scope: 'session',
        feedback: 'looks good',
        selected_label: 'Run',
      },
    });
    const env = envelopeOf<{ resolved: boolean; resolved_at: string }>(res.json());
    expect(env.code).toBe(0);
    expect(env.data?.resolved).toBe(true);
    expect(env.data?.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Promise settles with snake→camel adapted shape.
    const inProcResp: ApprovalResponse = await pending;
    expect(inProcResp.decision).toBe('approved');
    expect(inProcResp.scope).toBe('session');
    expect(inProcResp.feedback).toBe('looks good');
    expect(inProcResp.selectedLabel).toBe('Run');

    // Resolved broadcast also reaches the subscriber.
    const resolvedFrame = await waitFor(
      received,
      (f) => f['type'] === 'event.approval.resolved',
      2000,
    );
    const resolvedPayload = resolvedFrame['payload'] as {
      approval_id: string;
      decision: string;
      selected_label?: string;
    };
    expect(resolvedPayload.approval_id).toBe(payload.approval_id);
    expect(resolvedPayload.decision).toBe('approved');
    expect(resolvedPayload.selected_label).toBe('Run');

    ws.close();
  });

  it('GET pending approvals lists recoverable requests and omits resolved ones', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const broker = r.services.invokeFunction(
      (a) => a.get(IApprovalService) as ApprovalService,
    );

    const pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      turnId: 12,
      toolCallId: 'tc_approval_recovery',
      toolName: 'shell.run',
      action: 'Run `pwd`',
      display: { kind: 'command', command: 'pwd', summary: 'pwd' } as never,
    });

    let approvalId: string | undefined;
    try {
      const res = await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sid}/approvals?status=pending`,
      });
      const env = envelopeOf<{
        items: Array<{
          approval_id: string;
          session_id: string;
          turn_id?: number;
          tool_call_id: string;
          tool_name: string;
          action: string;
          tool_input_display: unknown;
          created_at: string;
          expires_at: string;
        }>;
      }>(res.json());
      expect(env.code).toBe(0);
      expect(env.data?.items).toHaveLength(1);

      const item = env.data?.items[0];
      expect(item).toBeDefined();
      approvalId = item?.approval_id;
      expect(item?.session_id).toBe(sid);
      expect(item?.turn_id).toBe(12);
      expect(item?.tool_call_id).toBe('tc_approval_recovery');
      expect(item?.tool_name).toBe('shell.run');
      expect(item?.action).toBe('Run `pwd`');
      expect(item?.tool_input_display).toEqual({
        kind: 'command',
        command: 'pwd',
        summary: 'pwd',
      });
      expect(item?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(item?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const ok = await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sid}/approvals/${approvalId}`,
        payload: { decision: 'approved' },
      });
      expect(envelopeOf<{ resolved: boolean }>(ok.json()).code).toBe(0);
      await pending;

      const after = await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sid}/approvals?status=pending`,
      });
      const afterEnv = envelopeOf<{ items: unknown[] }>(after.json());
      expect(afterEnv.code).toBe(0);
      expect(afterEnv.data?.items).toEqual([]);
    } finally {
      const cleanupId = approvalId ?? firstPendingApprovalId(broker);
      if (cleanupId !== undefined && broker.isPending(cleanupId)) {
        broker.resolve(cleanupId, { decision: 'cancelled' });
      }
      await pending.catch(() => undefined);
    }
  });

  it('GET pending approvals rejects unsupported status', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const res = await appOf(r).inject({
      method: 'GET',
      url: `/api/v1/sessions/${sid}/approvals?status=resolved`,
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });

  it('60s timeout broadcasts event.approval.expired + rejects with ApprovalExpiredError', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    // Swap in a short-timeout broker for this session — clean by reaching into
    // the container, since startDaemon doesn't expose a broker-options
    // override yet.
    const broker = r.services.invokeFunction(
      (a) => a.get(IApprovalService) as ApprovalService,
    );
    // Stamp the timeout via a private field hack — the test already
    // co-owns the impl. (In a fuller world we'd thread a `brokerOptions`
    // option through DaemonStartOptions.)
    (broker as unknown as { _timeoutMs: number })._timeoutMs = 40;

    const pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      toolCallId: 'tc_timeout',
      toolName: 'shell.run',
      action: 'Run',
      display: { kind: 'generic', summary: 'test' } as never,
      turnId: 1,
    });

    // Expect a rejection AND an event.approval.expired frame.
    let rejection: unknown;
    try {
      await pending;
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBeInstanceOf(ApprovalExpiredError);

    const expiredFrame = await waitFor(
      received,
      (f) => f['type'] === 'event.approval.expired',
      2000,
    );
    const payload = expiredFrame['payload'] as { approval_id: string };
    expect(payload.approval_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    ws.close();
  });

  it('REST resolve on unknown approval_id returns 40404', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/approvals/01JAAAAAAAAAAAAAAAAAAAAAAA`,
      payload: { decision: 'approved' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40404);
  });

  it('REST re-resolve on already-resolved approval returns 40902 with data:{resolved:false}', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const broker = r.services.invokeFunction(
      (a) => a.get(IApprovalService) as ApprovalService,
    );
    const pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      toolCallId: 'tc_idem',
      toolName: 'shell.run',
      action: 'Run',
      display: { kind: 'generic', summary: 'test' } as never,
    });

    // Capture the daemon-minted approval_id by inspecting the broker's
    // pending map (single entry).
    let approvalId: string | undefined;
    for (let i = 0; i < 20 && !approvalId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const peek = (broker as unknown as {
        _pending: Map<string, { approvalId: string }>;
      })._pending;
      approvalId = peek.values().next().value?.approvalId;
    }
    expect(approvalId).toBeDefined();

    // First resolve succeeds.
    const ok = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/approvals/${approvalId}`,
      payload: { decision: 'approved' },
    });
    const env1 = envelopeOf<{ resolved: boolean }>(ok.json());
    expect(env1.code).toBe(0);
    await pending;

    // Second resolve hits the idempotency window.
    const dup = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/approvals/${approvalId}`,
      payload: { decision: 'approved' },
    });
    const env2 = envelopeOf<{ resolved: boolean }>(dup.json());
    expect(env2.code).toBe(40902);
    expect(env2.data).toEqual({ resolved: false });
  });

  it('REST resolve with bad body returns 40001 (validation failure)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const broker = r.services.invokeFunction(
      (a) => a.get(IApprovalService) as ApprovalService,
    );
    const _pending = broker.request({
      sessionId: sid,
      agentId: 'main',
      toolCallId: 'tc_bad_body',
      toolName: 'shell.run',
      action: 'Run',
      display: { kind: 'generic', summary: 'test' } as never,
    });
    void _pending;

    // Reach into the pending map to grab the id.
    let approvalId: string | undefined;
    for (let i = 0; i < 20 && !approvalId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const peek = (broker as unknown as {
        _pending: Map<string, { approvalId: string }>;
      })._pending;
      approvalId = peek.values().next().value?.approvalId;
    }
    expect(approvalId).toBeDefined();

    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/approvals/${approvalId}`,
      payload: { decision: 'maybe' },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(Array.isArray(env.details)).toBe(true);

    // Cleanup: the broker still has the pending entry; settle it so the
    // afterEach close doesn't fight a hanging Promise.
    broker.resolve(approvalId!, { decision: 'cancelled' });
  });
});
