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
  ISessionMetadata,
  ITelemetryService,
  MAIN_AGENT_ID,
  resumeSessionById,
  SubagentSpawned,
  type CompactionResult,
  type TelemetryAppenderRecord,
} from '@moonshot-ai/agent-core-v2';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded, TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import {
  ToolCallStarted,
  ToolResultEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
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

interface RatingViewWire {
  phase: 'closed' | 'open' | 'pending' | 'thanks';
  appearance_id?: string;
  survey?: string;
  response?: string;
  settle_in_ms?: number;
  close_in_ms?: number;
}

const EVALUATION_IDLE_MS = 2100;

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

function idle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, EVALUATION_IDLE_MS));
}

class RatingClient {
  constructor(private readonly server: RunningServer) {}

  async request<T>(path: string, body?: unknown): Promise<Envelope<T>> {
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

  async mainAgentBus(sessionId: string): Promise<{ bus: IEventBus; dispatcher: IEventDispatcher }> {
    const agent = await this.mainAgent(sessionId);
    return { bus: agent.accessor.get(IEventBus), dispatcher: agent.accessor.get(IEventDispatcher) };
  }

  async finishUserTurn(
    sessionId: string,
    during?: (bus: IEventBus) => void,
  ): Promise<void> {
    const { bus, dispatcher } = await this.mainAgentBus(sessionId);
    const origin = { kind: 'user' } as const;
    await dispatcher.dispatch(new TurnPrompt({ agentId: MAIN_AGENT_ID, input: [], origin }));
    bus.publish(new TurnStarted({ agentId: MAIN_AGENT_ID, turnId: 1, origin }));
    during?.(bus);
    bus.publish(
      new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 1, reason: 'completed', traceId: 'trace-1' }),
    );
  }

  evaluate(sessionId: string): Promise<Envelope<RatingViewWire>> {
    return this.request<RatingViewWire>(`/api/v1/sessions/${sessionId}/rating`, {
      op: 'evaluate',
    });
  }

  async openRating(sessionId: string, during?: (bus: IEventBus) => void): Promise<string> {
    await this.finishUserTurn(sessionId, during);
    await idle();
    const opened = await this.evaluate(sessionId);
    if (opened.data.phase !== 'open' || opened.data.appearance_id === undefined) {
      throw new Error(`expected an open rating, got ${JSON.stringify(opened.data)}`);
    }
    return opened.data.appearance_id;
  }

  select(sessionId: string, appearanceId: string, response: string) {
    return this.request<RatingViewWire>(`/api/v1/sessions/${sessionId}/rating`, {
      op: 'select',
      appearance_id: appearanceId,
      response,
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

  it('reports closed for a session that has no rating', async () => {
    await expect(
      client.request<RatingViewWire>('/api/v1/sessions/unknown-session/rating'),
    ).resolves.toEqual(expect.objectContaining({ code: 0, data: { phase: 'closed' } }));
  });

  it('rejects a rating answer without an appearance id', async () => {
    const response = await client.request<null>('/api/v1/sessions/unknown-session/rating', {
      op: 'select',
      response: 'good',
    });

    expect(response.code).toBe(40001);
  });

  it('opens, answers, undoes, and abandons a preview rating as the session closes', async () => {
    const id = await client.createSession(home);
    const path = `/api/v1/sessions/${id}/rating`;
    const appearanceId = await client.openRating(id);

    const pending = await client.select(id, appearanceId, 'good');
    expect(pending.data).toMatchObject({ phase: 'pending', response: 'good' });
    expect(pending.data.settle_in_ms).toBeGreaterThan(2000);
    await expect(client.request<RatingViewWire>(path)).resolves.toMatchObject({
      data: { phase: 'pending', appearance_id: appearanceId },
    });

    const undone = await client.request<RatingViewWire>(path, {
      op: 'undo',
      appearance_id: appearanceId,
    });
    expect(undone.data).toEqual({ phase: 'open', appearance_id: appearanceId, survey: 'session' });

    await closeSessionById(server.core.accessor, id);
    await expect(client.request<RatingViewWire>(path)).resolves.toMatchObject({
      data: { phase: 'closed' },
    });
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
      await idle();

      await expect(client.evaluate(id)).resolves.toMatchObject({ data: { phase: 'closed' } });
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
    await idle();

    await expect(client.evaluate(id)).resolves.toMatchObject({ data: { phase: 'closed' } });
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
    await idle();
    await expect(ratings.evaluate(id)).resolves.toMatchObject({ data: { phase: 'closed' } });
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

  it('reports an open rating as abandoned when the session closes', async () => {
    const id = await client.createSession(home);
    await client.openRating(id);

    await closeSessionById(server.core.accessor, id);

    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 1],
      ['abandoned', undefined, 1],
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

  it('settles a chosen answer right away when the session is archived', async () => {
    const id = await client.createSession(home);
    const appearanceId = await client.openRating(id);
    await client.select(id, appearanceId, 'good');

    await client.request(`/api/v1/sessions/${id}:archive`, {});

    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 1],
      ['responded', 'good', 1],
    ]);
  });

  it('reports an open rating as abandoned when the session is deleted', async () => {
    const id = await client.createSession(home);
    await client.openRating(id);

    await client.request(`/api/v1/sessions/${id}:delete`, {});

    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 1],
      ['abandoned', undefined, 1],
    ]);
  });

  it('ends the rating on reload and counts the restored history afterwards', async () => {
    const id = await client.createSession(home);
    await client.finishUserTurn(id);
    await client.openRating(id);
    await getLiveSessionById(server.core.accessor, id)
      ?.accessor.get(ISessionMetadata)
      .registerAgent('sub-restored', { type: 'sub', labels: { profileName: 'coder' } });

    await client.request(`/api/v1/sessions/${id}:reload`, {});
    await expect(
      client.request<RatingViewWire>(`/api/v1/sessions/${id}/rating`),
    ).resolves.toMatchObject({ data: { phase: 'closed' } });
    await client.openRating(id);

    expect(ratingEvents(id)).toEqual([
      ['appeared', undefined, 2],
      ['abandoned', undefined, 2],
      ['appeared', undefined, 3],
    ]);
    expect(
      records
        .filter((record) => record.event === 'feedback_survey')
        .filter((record) => record.context['session_id'] === id)
        .map((record) => record.properties['subagent_count']),
    ).toEqual([0, 0, 1]);
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

  it('stays closed while telemetry is turned off in config.toml', async () => {
    await client.request('/api/v1/config', { telemetry: false });
    try {
      const id = await client.createSession(home);
      await client.finishUserTurn(id);
      await idle();

      await expect(client.evaluate(id)).resolves.toMatchObject({ data: { phase: 'closed' } });
      expect(ratingEvents(id)).toEqual([]);
    } finally {
      await client.request('/api/v1/config', { telemetry: true });
    }
  });

  it('answers a mismatched action with the current view', async () => {
    const id = await client.createSession(home);
    const appearanceId = await client.openRating(id);
    const path = `/api/v1/sessions/${id}/rating`;

    await expect(client.select(id, 'stale-appearance', 'bad')).resolves.toMatchObject({
      code: 0,
      data: { phase: 'open', appearance_id: appearanceId },
    });
    await expect(
      client.request<RatingViewWire>(path, { op: 'undo', appearance_id: appearanceId }),
    ).resolves.toMatchObject({ code: 0, data: { phase: 'open', appearance_id: appearanceId } });
  });

  it('reads the rating of an unloaded session without loading it', async () => {
    const id = await client.createSession(home);
    await closeSessionById(server.core.accessor, id);

    await expect(
      client.request<RatingViewWire>(`/api/v1/sessions/${id}/rating`),
    ).resolves.toMatchObject({ code: 0, data: { phase: 'closed' } });
    expect(getLiveSessionById(server.core.accessor, id)).toBeUndefined();
  });

  it('ends ratings silently when the server shuts down', async () => {
    const id = await client.createSession(home);
    const appearanceId = await client.openRating(id);
    await client.select(id, appearanceId, 'fine');

    await server.close();
    server = await startRatingServer();
    client = new RatingClient(server);

    expect(ratingEvents(id)).toEqual([['appeared', undefined, 1]]);
  });
});
