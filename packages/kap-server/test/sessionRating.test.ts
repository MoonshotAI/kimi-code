import { strictEqual } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  closeSessionById,
  CompactionCompleted,
  getLiveSessionById,
  IEventBus,
  IAgentProfileService,
  IEventDispatcher,
  ISessionManager,
  ISessionMetadata,
  ITelemetryService,
  MAIN_AGENT_ID,
  resumeSessionById,
  SubagentSpawned,
  type CompactionResult,
  type TelemetryAppenderRecord,
} from '@moonshot-ai/agent-core-v2';
import { ContextAppendMessage } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import {
  ToolCallStarted,
  ToolResultEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { TranscriptItem } from '@moonshot-ai/transcript';
import type { SessionRatingResult } from '../src/protocol/rest-session-rating';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { ensureMainAgent } from '../src/transport/mainAgent';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  data: T;
}

const OPEN_RIGHT_AWAY_SURVEY_POPUP = {
  probability: 1,
  min_time_before_feedback_ms: 0,
  min_user_turns_before_feedback: 0,
  min_time_between_feedback_ms: 0,
  min_user_turns_between_feedback: 0,
  min_time_between_global_feedback_ms: 0,
};

function serverEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env['KIMI_DISABLE_TELEMETRY'];
  return env;
}

class RatingClient {
  constructor(private readonly server: RunningServer) {}

  async request<T = unknown>(path: string, body?: unknown): Promise<Envelope<T>> {
    const response = await fetch(`http://127.0.0.1:${this.server.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: authHeaders(this.server, { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()) as Envelope<T>;
  }

  async createSession(cwd: string): Promise<string> {
    const created = await this.request<{ id: string }>('/api/v1/sessions', { metadata: { cwd } });
    return created.data.id;
  }

  async mainAgent(sessionId: string) {
    const session =
      getLiveSessionById(this.server.core.accessor, sessionId) ??
      (await resumeSessionById(this.server.core.accessor, sessionId));
    if (session === undefined) throw new Error('expected a session');
    return ensureMainAgent(session);
  }

  async finishUserTurn(sessionId: string, during?: (bus: IEventBus) => void, turnId = 1): Promise<void> {
    const agent = await this.mainAgent(sessionId);
    strictEqual((await this.request(`/api/v1/sessions/${sessionId}/transcript?agent_id=main`)).code, 0);
    const bus = agent.accessor.get(IEventBus);
    const dispatcher = agent.accessor.get(IEventDispatcher);
    const origin = { kind: 'user' } as const;
    await dispatcher.dispatch(new TurnPrompt({ agentId: MAIN_AGENT_ID, input: [], origin }));
    bus.publish(new TurnStarted({ agentId: MAIN_AGENT_ID, turnId, origin }));
    during?.(bus);
    bus.publish(new TurnEnded({
      agentId: MAIN_AGENT_ID, turnId, reason: 'completed', requestId: 'trace-1',
    }));
  }

  async latestTurnId(sessionId: string): Promise<string> {
    const transcript = await this.request<{ items: TranscriptItem[] }>(
      `/api/v1/sessions/${sessionId}/transcript?agent_id=main`,
    );
    const turn = transcript.data.items.findLast((item) => item.kind === 'turn');
    if (turn === undefined) throw new Error('expected a transcript turn');
    return turn.turnId;
  }

  async evaluate(sessionId: string, turnId?: string): Promise<Envelope<SessionRatingResult>> {
    return this.request(`/api/v1/sessions/${sessionId}/rating`, {
      op: 'evaluate', turn_id: turnId ?? await this.latestTurnId(sessionId),
    });
  }

  async openRating(sessionId: string, during?: (bus: IEventBus) => void): Promise<string> {
    await this.finishUserTurn(sessionId, during);
    const opened = await this.evaluate(sessionId);
    if (opened.data.appearance === null) throw new Error('expected a rating offer');
    const id = opened.data.appearance.id;
    await this.report(sessionId, id, 'shown');
    return id;
  }

  report(sessionId: string, appearanceId: string, op: 'shown' | 'abandon') {
    return this.request<null>(`/api/v1/sessions/${sessionId}/rating`, {
      op, appearance_id: appearanceId,
    });
  }

  respond(sessionId: string, appearanceId: string, response: string) {
    return this.request<null>(`/api/v1/sessions/${sessionId}/rating`, {
      op: 'respond', appearance_id: appearanceId, response,
    });
  }
}

describe('session rating preview', () => {
  let server: RunningServer;
  let home: string;
  let client: RatingClient;
  const logLines: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rating-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      debugEndpoints: true,
      env: serverEnv({ KIMI_CODE_SESSION_RATING_PREVIEW: '1' }),
      logger: pino(
        { level: 'info' },
        new Writable({
          write(chunk, _encoding, callback) {
            logLines.push(String(chunk));
            callback();
          },
        }),
      ),
    });
    client = new RatingClient(server);
  });

  afterAll(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function previewEvents(): [unknown, unknown, unknown][] {
    return logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['msg'] === 'session rating preview event')
      .map((entry) => [entry['event'], entry['event_type'], entry['response']]);
  }

  it('returns no offer for an unloaded session', async () => {
    expect(await client.evaluate('unknown-session', 'turn-1')).toMatchObject({
      code: 0, data: { appearance: null },
    });
  });

  it.each([
    { op: 'respond', response: 'good' },
    { op: 'evaluate' },
    { op: 'select', appearance_id: 'old', response: 'good' },
    { op: 'undo', appearance_id: 'old' },
    { op: 'respond', appearance_id: 'old', response: 'invalid' },
  ])('rejects a malformed or removed operation %j', async (body) => {
    expect(await client.request('/api/v1/sessions/unknown-session/rating', body))
      .toMatchObject({ code: 40001 });
  });

  it('only records a display when the client confirms it', async () => {
    const id = await client.createSession(home);
    await client.finishUserTurn(id);
    const { data } = await client.evaluate(id);
    if (data.appearance === null) throw new Error('expected an offer');
    expect(previewEvents()).toEqual([]);
    await client.report(id, data.appearance.id, 'shown');
    await closeSessionById(server.core.accessor, id);
    expect(previewEvents()).toEqual([['feedback_survey', 'appeared', undefined]]);
    await client.report(id, data.appearance.id, 'abandon');
    expect(previewEvents()).toEqual([
      ['feedback_survey', 'appeared', undefined],
      ['feedback_survey', 'abandoned', undefined],
    ]);
  });

  it('stays closed while disable_feedback_survey is set in config.toml', async () => {
    const before = previewEvents().length;
    await client.request('/api/v1/config', { disable_feedback_survey: true });
    try {
      const id = await client.createSession(home);
      await client.finishUserTurn(id);
      expect(await client.evaluate(id)).toMatchObject({ data: { appearance: null } });
      expect(previewEvents()).toHaveLength(before);
    } finally {
      await client.request('/api/v1/config', { disable_feedback_survey: false });
    }
  });
});

describe('session rating preview outside development', () => {
  let server: RunningServer;
  let home: string;
  let client: RatingClient;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rating-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      env: serverEnv({
        KIMI_CODE_SESSION_RATING_PREVIEW: '1',
        KIMI_CODE_BASE_URL: 'http://127.0.0.1:9',
      }),
      logger: pino({ level: 'silent' }),
    });
    client = new RatingClient(server);
  });

  afterAll(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('ignores the preview switch when debug endpoints are off', async () => {
    const id = await client.createSession(home);
    await client.finishUserTurn(id);

    await expect(client.evaluate(id)).resolves.toMatchObject({ data: { appearance: null } });
  });
});

describe('session rating lifecycle', () => {
  let server: RunningServer;
  let home: string;
  let client: RatingClient;
  let configServer: Server;
  let configRequests = 0;
  const records: TelemetryAppenderRecord[] = [];

  const MANAGED_MODEL_CONFIG = [
    'default_model = "kimi-code/k3"',
    '',
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'base_url = "https://api.kimi.com/coding/v1"',
    'api_key = "test-key"',
    '',
    '[models."kimi-code/k3"]',
    'provider = "managed:kimi-code"',
    'model = "k3"',
    'max_context_size = 262144',
    '',
  ].join('\n');

  async function startRatingServer(): Promise<RunningServer> {
    const port = (configServer.address() as AddressInfo).port;
    const started = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      env: serverEnv({ KIMI_CODE_BASE_URL: `http://127.0.0.1:${port}` }),
      logger: pino({ level: 'silent' }),
    });
    started.core.accessor.get(ITelemetryService).addAppender({
      track: (record) => {
        records.push(record);
      },
    });
    return started;
  }

  async function warmUpConfig(ratings: RatingClient): Promise<void> {
    const id = await ratings.createSession(home);
    await ratings.finishUserTurn(id);
    await expect(ratings.evaluate(id)).resolves.toMatchObject({ data: { appearance: null } });
    await vi.waitFor(() => {
      if (configRequests === 0) throw new Error('survey_popup has not been fetched yet');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  function ratingEvents(sessionId: string): [unknown, unknown, unknown][] {
    return records
      .filter((record) => record.event === 'feedback_survey')
      .filter((record) => record.context['session_id'] === sessionId)
      .map((record) => [
        record.properties['event_type'],
        record.properties['response'],
        record.properties['user_turn_count'],
      ]);
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rating-'));
    configServer = createServer((req, res) => {
      configRequests += 1;
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: 'survey_popup', config: OPEN_RIGHT_AWAY_SURVEY_POPUP }));
      });
    });
    await new Promise<void>((resolve) => configServer.listen(0, '127.0.0.1', resolve));
    await writeFile(join(home, 'config.toml'), MANAGED_MODEL_CONFIG, 'utf8');
    server = await startRatingServer();
    client = new RatingClient(server);
    await warmUpConfig(client);
  });

  afterAll(async () => {
    await server.close();
    await new Promise((resolve) => configServer.close(resolve));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('does not settle on close and accepts an answer after the scope is disposed', async () => {
    const id = await client.createSession(home);
    const appearance = await client.openRating(id);
    await closeSessionById(server.core.accessor, id);
    expect(ratingEvents(id)).toEqual([['appeared', undefined, 1]]);
    await client.respond(id, appearance, 'good');
    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 1], ['responded', 'good', 1],
    ]);
  });

  it('identifies the managed model and its trace for the kfc check', async () => {
    const id = await client.createSession(home);
    await (await client.mainAgent(id)).accessor.get(IAgentProfileService).setModel('kimi-code/k3');
    await client.openRating(id);

    const appeared = records.find(
      (record) =>
        record.event === 'feedback_survey' &&
        record.context['session_id'] === id &&
        record.properties['event_type'] === 'appeared',
    );
    expect(appeared?.properties).toMatchObject({
      current_model: 'kimi-code/k3',
      kfc_model_id: 'k3',
      kfc_trace_id: 'trace-1',
    });
  });

  it.each(['archive', 'delete', 'reload'] as const)(
    'accepts a delayed answer after %s without automatically abandoning it', async (action) => {
      const id = await client.createSession(home);
      const appearance = await client.openRating(id);
      await client.request(`/api/v1/sessions/${id}:${action}`, {});
      expect(ratingEvents(id)).toEqual([['appeared', undefined, 1]]);
      await client.respond(id, appearance, 'fine');
      await client.respond(id, appearance, 'bad');
      await client.report(id, appearance, 'abandon');
      expect(ratingEvents(id)).toEqual([
        ['appeared', undefined, 1], ['responded', 'fine', 1],
      ]);
    },
  );

  it('keeps the old snapshot after reload and counts restored history for the next offer', async () => {
    const id = await client.createSession(home);
    await client.finishUserTurn(id);
    const oldAppearance = await client.openRating(id);
    await getLiveSessionById(server.core.accessor, id)?.accessor.get(ISessionMetadata)
      .registerAgent('sub-restored', { type: 'sub', labels: { profileName: 'coder' } });
    await client.request(`/api/v1/sessions/${id}:reload`, {});
    await client.openRating(id);
    await client.respond(id, oldAppearance, 'good');
    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 2], ['appeared', undefined, 3], ['responded', 'good', 2],
    ]);
    expect(records.filter((r) => r.event === 'feedback_survey' && r.context['session_id'] === id)
      .map((r) => r.properties['subagent_count'])).toEqual([0, 1, 0]);
  });

  it('rejects an old turn without consuming the newer turn evaluation', async () => {
    const id = await client.createSession(home);
    await client.finishUserTurn(id);
    const oldTurn = await client.latestTurnId(id);
    await client.finishUserTurn(id);
    const newTurn = await client.latestTurnId(id);
    expect(newTurn).not.toBe(oldTurn);
    expect(await client.evaluate(id, oldTurn)).toMatchObject({ data: { appearance: null } });
    const result = await client.evaluate(id, newTurn);
    expect(result.data.appearance).toMatchObject({ survey: 'session' });
    if (result.data.appearance === null) throw new Error('expected an offer');
    await client.respond(id, result.data.appearance.id, 'good');
    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 2], ['responded', 'good', 2],
    ]);
  });

  it('gives only one client an offer for the same turn', async () => {
    const id = await client.createSession(home);
    await client.finishUserTurn(id);
    const turnId = await client.latestTurnId(id);
    const results = await Promise.all([client.evaluate(id, turnId), client.evaluate(id, turnId)]);
    expect(results.map((r) => r.data.appearance?.survey ?? null).toSorted()).toEqual([null, 'session']);
  });

  it('does not discard an earlier answer when the next evaluation arrives first', async () => {
    const id = await client.createSession(home);
    const first = await client.openRating(id);
    const second = await client.openRating(id);
    await client.respond(id, second, 'bad');
    await client.respond(id, first, 'good');
    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 1], ['appeared', undefined, 2],
      ['responded', 'bad', 2], ['responded', 'good', 1],
    ]);
  });

  it('binds reports to the session in the URL', async () => {
    const id = await client.createSession(home);
    const other = await client.createSession(home);
    const appearance = await client.openRating(id);
    expect(await client.respond(other, appearance, 'bad')).toMatchObject({ code: 0, data: null });
    expect(ratingEvents(other)).toEqual([]);
    expect(ratingEvents(id)).toEqual([['appeared', undefined, 1]]);
    await client.respond(id, appearance, 'good');
    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 1], ['responded', 'good', 1],
    ]);
  });

  it('reports the tool calls, subagents, and compactions seen on the main agent', async () => {
    const id = await client.createSession(home);
    await client.openRating(id, (bus) => {
      const turn = { agentId: MAIN_AGENT_ID, turnId: 1 };
      bus.publish(new ToolCallStarted({ ...turn, toolCallId: 'call-agent', name: 'Agent', args: {} }));
      bus.publish(
        new SubagentSpawned({
          subagentId: 'sub-1',
          subagentName: 'coder',
          parentToolCallId: 'call-agent',
          runInBackground: false,
          model: 'model-a',
        }),
      );
      bus.publish(new ToolResultEvent({ ...turn, toolCallId: 'call-agent', output: 'done' }));
      bus.publish(new ToolCallStarted({ ...turn, toolCallId: 'call-read', name: 'Read', args: {} }));
      bus.publish(
        new CompactionCompleted({
          agentId: MAIN_AGENT_ID,
          result: { tokensBefore: 10, tokensAfter: 5 } as unknown as CompactionResult,
        }),
      );
    });

    const appeared = records.find(
      (record) =>
        record.event === 'feedback_survey' &&
        record.context['session_id'] === id &&
        record.properties['event_type'] === 'appeared',
    );
    expect(appeared?.properties).toMatchObject({
      tool_call_count: 2,
      subagent_count: 1,
      subagent_models: 'model-a',
      swarm_run_count: 0,
      compaction_count: 1,
    });
  });

  it('checks telemetry consent during evaluation and reporting', async () => {
    const id = await client.createSession(home);
    const appearance = await client.openRating(id);
    await client.request('/api/v1/config', { telemetry: false });
    try {
      await client.respond(id, appearance, 'good');
      await client.finishUserTurn(id);
      expect(await client.evaluate(id)).toMatchObject({ data: { appearance: null } });
      expect(ratingEvents(id)).toEqual([['appeared', undefined, 1]]);
    } finally {
      await client.request('/api/v1/config', { telemetry: true });
    }
  });

  it('resumes and evaluates a completed turn for a cold session', async () => {
    const id = await client.createSession(home);
    await (await client.mainAgent(id)).accessor.get(IAgentProfileService).setModel('kimi-code/k3');
    await client.finishUserTurn(id, undefined, 0);
    const agent = await client.mainAgent(id);
    const dispatcher = agent.accessor.get(IEventDispatcher);
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please review this answer.' }],
          origin: { kind: 'user' },
        },
      }),
    );
    await dispatcher.dispatch(
      new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 0, reason: 'completed', requestId: 'trace-1' }),
    );
    const turnId = await client.latestTurnId(id);
    expect(await server.core.accessor.get(ISessionManager).closeIfIdle(id, 0)).toBe(true);
    const result = await client.evaluate(id, turnId);
    expect(result.data.appearance).toMatchObject({ survey: 'session' });
    expect(getLiveSessionById(server.core.accessor, id)).not.toBeUndefined();
    if (result.data.appearance === null) throw new Error('expected a rating offer');
    await client.report(id, result.data.appearance.id, 'shown');
    const appeared = records.find(
      (record) =>
        record.event === 'feedback_survey' &&
        record.context['session_id'] === id &&
        record.properties['event_type'] === 'appeared',
    );
    expect(appeared?.properties).toMatchObject({ kfc_trace_id: 'trace-1', user_turn_count: 1 });
  });

  it('does not load sessions when evaluating or reporting unknown appearances', async () => {
    const id = await client.createSession(home);
    await closeSessionById(server.core.accessor, id);
    expect(await client.evaluate(id, 'turn-1')).toMatchObject({ code: 0, data: { appearance: null } });
    expect(await client.respond(id, 'unknown', 'good')).toMatchObject({ code: 0, data: null });
    expect(getLiveSessionById(server.core.accessor, id)).toBeUndefined();
  });

  it('does not recover unfinished appearances after server restart', async () => {
    const id = await client.createSession(home);
    const appearance = await client.openRating(id);
    await server.close();
    server = await startRatingServer();
    client = new RatingClient(server);
    await client.respond(id, appearance, 'fine');
    expect(ratingEvents(id)).toEqual([['appeared', undefined, 1]]);
  });
});
