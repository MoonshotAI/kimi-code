import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ClientCapabilities } from '@agentclientprotocol/sdk';
import { writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, finishWith, httpError, read, say } from '@moonshot-ai/testkit/model';
import {
  homeFixtures,
  modelFixtures,
  useNetworkGuard,
  type HomeFixtures,
  type ModelFixtures,
} from '@moonshot-ai/testkit/vitest';
import { describe, expect, test as base, vi } from 'vitest';

import { retryingToSessionUpdate } from '../src/events-map';
import { AcpSession } from '../src/session';
import { createTestClient, type TestClient } from './_helpers/acpClient';

useNetworkGuard();
type Fixtures = HomeFixtures & ModelFixtures;
const test = base.extend<Fixtures>({ ...homeFixtures(), ...modelFixtures() });

async function inAcpSession(
  fixtures: Fixtures,
  loopControl: Readonly<Record<string, number>>,
  run: (client: TestClient, sessionId: string) => Promise<void>,
  clientCapabilities: ClientCapabilities = {},
): Promise<void> {
  await fixtures.model.listen();
  await writeKimiConfig(fixtures.testHome.dataDir, { ...fakeModelConfig(fixtures.model), loopControl });
  const client = await createTestClient({ homeDir: fixtures.testHome.dataDir });
  try {
    await client.send('initialize', { protocolVersion: 1, clientCapabilities });
    const { sessionId } = (await client.send('session/new', {
      cwd: fixtures.testHome.workspace,
      mcpServers: [],
    })) as { sessionId: string };
    await run(client, sessionId);
  } finally {
    await client.close();
  }
}

function promptAnswer(client: TestClient, sessionId: string, text: string): Promise<unknown> {
  return client.send('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error: JSON.parse((error as Error).message) as unknown }),
  );
}

function agentText(client: TestClient, sessionId: string): string {
  return client
    .sessionUpdates()
    .map(
      (message) =>
        message.params as {
          sessionId: string;
          update: { sessionUpdate: string; content?: { text?: string } };
        },
    )
    .filter(
      (message) =>
        message.sessionId === sessionId && message.update.sessionUpdate === 'agent_message_chunk',
    )
    .map((message) => message.update.content?.text ?? '')
    .join('');
}

function updatesOf(
  client: TestClient,
  sessionId: string,
  kind: string,
): Array<{ sessionUpdate: string; description?: string }> {
  return client
    .sessionUpdates()
    .map(
      (message) =>
        message.params as {
          sessionId: string;
          update: { sessionUpdate: string; description?: string };
        },
    )
    .filter((message) => message.sessionId === sessionId && message.update.sessionUpdate === kind)
    .map((message) => message.update);
}

describe('how session/prompt answers a turn that ended', () => {
  test('answers with the error when a model request fails, and takes the next prompt', { timeout: 30_000 }, async ({ model, testHome }) => {
    model.script(
      httpError(400, { message: 'The model service rejected the request.' }),
      say('Recovered.'),
    );
    await inAcpSession({ model, testHome }, {}, async (client, sessionId) => {
      expect(await promptAnswer(client, sessionId, 'Trigger a failure.')).toMatchObject({
        error: {
          code: -32603,
          message: expect.stringContaining('The model service rejected the request.'),
          data: { code: 'provider.api_error' },
        },
      });
      expect(await promptAnswer(client, sessionId, 'Try again.')).toMatchObject({
        result: { stopReason: 'end_turn' },
      });
      expect(agentText(client, sessionId)).toBe('Recovered.');
    });
    expect(model.requests('main').map((request) => request.state)).toEqual([
      'failed',
      'finished',
    ]);
  });

  test('answers with the error when a turn runs out of steps', { timeout: 30_000 }, async ({ model, testHome }) => {
    const notes = join(testHome.workspace, 'notes.txt');
    await writeFile(notes, 'Step one.\n');
    model.script(read(notes));
    await inAcpSession({ model, testHome }, { max_steps_per_turn: 1 }, async (client, sessionId) => {
      expect(await promptAnswer(client, sessionId, 'Keep going.')).toMatchObject({
        error: {
          code: -32603,
          message: expect.stringContaining('max_steps_per_turn'),
          data: { code: 'loop.max_steps_exceeded' },
        },
      });
    });
    expect(model.requests('main')).toHaveLength(1);
  });

  test('answers with auth_required when the model service rejects the credentials', { timeout: 30_000 }, async ({ model, testHome }) => {
    model.script(httpError(401, { message: 'The credentials were rejected.' }));
    await inAcpSession({ model, testHome }, {}, async (client, sessionId) => {
      expect(await promptAnswer(client, sessionId, 'Hello.')).toMatchObject({
        error: { code: -32000, message: expect.stringContaining('The credentials were rejected.') },
      });
    });
  });

  test('ends with refusal when the model service filters the response', { timeout: 30_000 }, async ({ model, testHome }) => {
    model.script(finishWith('filtered', say('Partial.')));
    await inAcpSession({ model, testHome }, {}, async (client, sessionId) => {
      expect(await promptAnswer(client, sessionId, 'Hello.')).toMatchObject({
        result: { stopReason: 'refusal' },
      });
    });
  });
});

describe('retry progress notifications', () => {
  test('sends live notices for each retry without adding assistant text', { timeout: 30_000 }, async ({ model, testHome }) => {
    const failure = httpError(429, {
      message: 'The example service is not ready yet.',
      retryAfterSeconds: 1,
    });
    model.script(failure, failure, say('Recovered.'));
    await inAcpSession(
      { model, testHome },
      {},
      async (client, sessionId) => {
        expect(await promptAnswer(client, sessionId, 'Trigger retries.')).toMatchObject({
          result: { stopReason: 'end_turn' },
        });
        const notices = updatesOf(client, sessionId, 'notice');
        expect(notices).toHaveLength(2);
        expect(notices[0]).toMatchObject({
          severity: 'warning',
          title: 'Model request failed; retrying (attempt 2)',
          description: expect.stringContaining('in 1s'),
        });
        expect(notices[0]?.description).toContain('429');
        expect(notices[0]?.description).toContain('The example service is not ready yet.');
        expect(notices[1]).toMatchObject({ title: 'Model request failed; retrying (attempt 3)' });
        expect(agentText(client, sessionId)).toBe('Recovered.');
      },
      { session: { notices: {} } },
    );
    expect(model.requests('main').map((request) => request.state)).toEqual([
      'failed',
      'failed',
      'finished',
    ]);
  });

  test('falls back to an assistant-visible message that stays out of model history', { timeout: 30_000 }, async ({ model, testHome }) => {
    model.script(
      httpError(429, { message: 'The example service is not ready yet.', retryAfterSeconds: 1 }),
      say('Recovered.'),
    );
    await inAcpSession({ model, testHome }, {}, async (client, sessionId) => {
      expect(await promptAnswer(client, sessionId, 'Trigger a retry.')).toMatchObject({
        result: { stopReason: 'end_turn' },
      });
      expect(updatesOf(client, sessionId, 'notice')).toHaveLength(0);
      const text = agentText(client, sessionId);
      expect(text).toContain('Model request failed; retrying (attempt 2)');
      expect(text).toContain('429');
      expect(text).toContain('The example service is not ready yet.');
      expect(text.endsWith('\n\nRecovered.')).toBe(true);
      expect(JSON.stringify(model.requests('main')[1]?.view.messages)).not.toContain(
        'Model request failed; retrying',
      );
    });
  });

  test('does not present an unbounded retry as exceeding a finite maximum', () => {
    const notification = retryingToSessionUpdate(
      'session-test',
      {
        failedAttempt: 10,
        nextAttempt: 11,
        maxAttempts: 10,
        delayMs: 0,
        errorName: 'rate_limit',
        errorMessage: 'Try again.',
        statusCode: 429,
      },
      true,
    );
    expect(notification).toMatchObject({
      update: {
        sessionUpdate: 'notice',
        title: 'Model request failed; retrying (attempt 11)',
        description: expect.stringContaining('immediately'),
      },
    });
  });
});

describe('a turn that fails after the editor asked to cancel it', () => {
  interface Launched {
    readonly turn_id: number;
  }

  function cancellableSession(): {
    readonly session: AcpSession;
    readonly cancels: unknown[];
    promptSent(): boolean;
    launch(launched: Launched): void;
    turnId(): number | undefined;
    endTurnWithFailure(turnId: number): void;
  } {
    const cancels: unknown[] = [];
    let launch: ((launched: Launched) => void) | undefined;
    const session = Object.create(AcpSession.prototype) as AcpSession;
    const internals = session as unknown as {
      driver?: { turnId?: number };
      onTurnEnded(event: unknown): void;
    };
    Object.assign(session as unknown as Record<string, unknown>, {
      sessionId: 'session-test',
      skills: [],
      hostCommands: [],
      pendingPromptAborts: new Set(),
      conn: { sessionUpdate: async () => {} },
      klient: { global: { kosong: { listModels: async () => [] } } },
      agent: {
        prompt: () =>
          new Promise<Launched>((resolve) => {
            launch = resolve;
          }),
        cancel: async (target?: unknown) => {
          cancels.push(target);
        },
      },
    });
    return {
      session,
      cancels,
      promptSent: () => launch !== undefined,
      launch: (launched) => {
        if (launch === undefined) throw new Error('the session has not launched a turn yet');
        launch(launched);
      },
      turnId: () => internals.driver?.turnId,
      endTurnWithFailure: (turnId) => {
        internals.onTurnEnded({
          turnId,
          reason: 'failed',
          error: { code: 'provider.api_error', message: 'The model service rejected the request.' },
        });
      },
    };
  }

  test('ends with cancelled when the cancel arrived before the turn started', async () => {
    const editor = cancellableSession();
    const answer = editor.session.prompt([{ type: 'text', text: 'Hello.' }]);
    await vi.waitFor(() => {
      expect(editor.promptSent()).toBe(true);
    });
    editor.session.cancel();
    editor.launch({ turn_id: 7 });
    await vi.waitFor(() => {
      expect(editor.turnId()).toBe(7);
    });
    expect(editor.cancels).toEqual([undefined, { turnId: 7 }]);
    editor.endTurnWithFailure(7);

    await expect(answer).resolves.toEqual({ stopReason: 'cancelled' });
  });

  test('ends with cancelled when the cancel arrived while the turn was running', async () => {
    const editor = cancellableSession();
    const answer = editor.session.prompt([{ type: 'text', text: 'Hello.' }]);
    await vi.waitFor(() => {
      expect(editor.promptSent()).toBe(true);
    });
    editor.launch({ turn_id: 7 });
    await vi.waitFor(() => {
      expect(editor.turnId()).toBe(7);
    });
    editor.session.cancel();
    expect(editor.cancels).toEqual([{ turnId: 7 }]);
    editor.endTurnWithFailure(7);

    await expect(answer).resolves.toEqual({ stopReason: 'cancelled' });
  });
});
