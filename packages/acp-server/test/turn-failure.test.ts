import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import { writeKimiConfig } from '@moonshot-ai/testkit/fixtures';
import { agent, fakeModelConfig, finishWith, held, httpError, read, say } from '@moonshot-ai/testkit/model';
import {
  homeFixtures,
  modelFixtures,
  useNetworkGuard,
  type HomeFixtures,
  type ModelFixtures,
} from '@moonshot-ai/testkit/vitest';
import { describe, expect, test as base, vi } from 'vitest';

import { AcpSession } from '../src/session';
import { createTestClient, type TestClient } from './_helpers/acpClient';

useNetworkGuard();
type Fixtures = HomeFixtures & ModelFixtures;
const test = base.extend<Fixtures>({ ...homeFixtures(), ...modelFixtures() });

async function inAcpSession(
  fixtures: Fixtures,
  loopControl: Readonly<Record<string, number>>,
  run: (client: TestClient, sessionId: string) => Promise<void>,
): Promise<void> {
  await fixtures.model.listen();
  await writeKimiConfig(fixtures.testHome.dataDir, { ...fakeModelConfig(fixtures.model), loopControl });
  const client = await createTestClient({ homeDir: fixtures.testHome.dataDir });
  try {
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
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

test('streams a background task notification between editor prompts', { timeout: 30_000 }, async ({ model, testHome }) => {
  const started = 'Started the count in the background.';
  const finished = 'The background count is done: 42 files.';
  const next = 'Here is the next answer.';
  const overlapping = 'Send a prompt while the report is running.';
  const notes = join(testHome.workspace, 'notes.txt');
  await writeFile(notes, 'Example notes.\n');
  model.script(
    agent({ prompt: 'Count the files.', description: 'Count files', run_in_background: true }),
    say(started),
    held('report', read(notes, { id: 'notification_read' })),
    say(finished),
    say(next),
  );
  model.lane('subagent').script(held('counting', say('42 files')));

  await inAcpSession({ model, testHome }, {}, async (client, sessionId) => {
    const updates = () => client.sessionUpdates()
      .map(({ params }) => params as SessionNotification)
      .filter((params) => params.sessionId === sessionId)
      .map(({ update }) => update);

    expect(await promptAnswer(client, sessionId, 'Count the files in the background.')).toEqual({
      result: { stopReason: 'end_turn' },
    });
    await model.hold('counting').reached();
    expect(agentText(client, sessionId)).toBe(started);

    model.hold('counting').release();
    await model.hold('report').reached();
    expect(await promptAnswer(client, sessionId, overlapping)).toMatchObject({
      error: { code: -32600, data: { code: 'turn.agent_busy' } },
    });
    model.hold('report').release();
    await expect.poll(() => agentText(client, sessionId)).toBe(started + finished);
    const readCallId = updates()
      .filter((update) => update.sessionUpdate === 'tool_call')
      .find((update) => update.toolCallId.endsWith(':notification_read'))?.toolCallId;
    expect(readCallId).toBeDefined();
    expect(updates()).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call_update',
      toolCallId: readCallId,
      status: 'completed',
    }));
    expect(model.requests('main')[2]?.texts('user').join('\n')).toContain('type="task.completed"');

    await expect.poll(() => updates().filter((update) => update.sessionUpdate === 'usage_update')).toHaveLength(2);
    expect(await promptAnswer(client, sessionId, 'What is next?')).toEqual({ result: { stopReason: 'end_turn' } });
    expect(agentText(client, sessionId)).toBe(started + finished + next);
    expect(model.requests('main').map((request) => request.texts('user').join('\n')).join('\n')).not.toContain(overlapping);
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
    startTaskNotification(turnId: number): void;
    launch(launched: Launched): void;
    turnId(): number | undefined;
    endTurnWithFailure(turnId: number): void;
  } {
    const cancels: unknown[] = [];
    let launch: ((launched: Launched) => void) | undefined;
    const session = Object.create(AcpSession.prototype) as AcpSession;
    const internals = session as unknown as {
      driver?: { turnId?: number };
      taskNotificationTurnId?: number;
      onTurnEnded(event: unknown): void;
    };
    Object.assign(session as unknown as Record<string, unknown>, {
      sessionId: 'session-test',
      skills: [],
      hostCommands: [],
      pendingPromptAborts: new Set(),
      terminalsAwaitingCall: [],
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
      startTaskNotification: (turnId) => {
        internals.taskNotificationTurnId = turnId;
      },
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

  test('does not cancel a task notification while the editor prompt has no assigned turn', async () => {
    const editor = cancellableSession();
    const answer = editor.session.prompt([{ type: 'text', text: 'Hello.' }]);
    await vi.waitFor(() => {
      expect(editor.promptSent()).toBe(true);
    });
    editor.startTaskNotification(7);
    editor.session.cancel();
    expect(editor.cancels).toEqual([]);

    editor.endTurnWithFailure(7);
    editor.launch({ turn_id: 8 });
    await vi.waitFor(() => {
      expect(editor.turnId()).toBe(8);
    });
    expect(editor.cancels).toEqual([{ turnId: 8 }]);
    editor.endTurnWithFailure(8);
    await expect(answer).resolves.toEqual({ stopReason: 'cancelled' });
  });
});
