import { rm } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';
import {
  ensureMainAgent,
  getLiveSessionById,
  IAgentLifecycleService,
  IEventBus,
} from '@moonshot-ai/agent-core-v2';
import { TurnPrompt } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient } from '../src/transports/memory/index.js';
import { createMemoryDispatcher } from '../src/transports/memory/dispatcher.js';
import { RPCError } from '../src/core/errors.js';
import { makeEngine } from './helpers/engine.js';

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  const klient = createKlient({ scope: app });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('memory dispatcher specifics', () => {
  it('rejects unknown services and methods with RPCError(40001)', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'noSuchService', 'get', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(dispatcher.call({}, 'sessionIndex', 'noSuchMethod', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('reads non-function members as properties', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).resolves.toBe(
      process.platform,
    );
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('rejects session/agent scopes for now', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionIndex', 'list', [{}]),
    ).rejects.toBeInstanceOf(RPCError);
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('delivers wire-cloned payloads including observable turn prompts', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app, validate: false });
    try {
      const list = await klient.global.workspaces.list();
      // Mutating the result must not affect what a second call returns.
      (list as unknown[]).push({ id: 'polluted' });
      const again = await klient.global.workspaces.list();
      expect(again.some((w) => w.id === 'polluted')).toBe(false);

      const created = await klient.global.sessions.create({ workDir: process.cwd() });
      const session = getLiveSessionById(app.accessor, created.id);
      if (session === undefined) throw new Error('expected live session');
      await ensureMainAgent(session);
      const main = session.accessor.get(IAgentLifecycleService).handleOf('main');
      if (main === undefined) throw new Error('expected main agent');
      const seen: unknown[] = [];
      const direct: unknown[] = [];
      session.accessor.get(ISessionEventBus).subscribe((event) => direct.push(event));
      createMemoryDispatcher(app).listen(
        { sessionId: created.id, agentId: 'main' },
        { kind: 'stream', name: 'events' },
        (event) => seen.push(event),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      main.accessor.get(IEventBus).publish(new TurnPrompt({
        agentId: 'main',
        turnId: 1,
        input: [{ type: 'text', text: '<notification>internal only</notification>' }],
        origin: { kind: 'task', taskId: 'task_1', status: 'completed', notificationId: 'task:task_1:completed' },
      }));
      await vi.waitFor(() => {
        expect(direct).toHaveLength(1);
      }, { timeout: 1000 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        type: 'turn.prompt',
        turnId: 1,
        input: [{ type: 'text', text: '<notification>internal only</notification>' }],
      });
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('does not respond to interactions owned by another session', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const dispatcher = createMemoryDispatcher(app);
    const first = await klient.global.sessions.create({ workDir: process.cwd() });
    const second = await klient.global.sessions.create({ workDir: process.cwd() });
    try {
      const parked = (await dispatcher.call({ sessionId: first.id }, 'sessionInteractionService', 'enqueue', [
        {
          kind: 'approval',
          payload: {
            toolName: 'Bash',
            action: 'run',
            display: { kind: 'command', command: 'ls' },
          },
        },
      ])) as { id: string };

      await dispatcher.call({ sessionId: second.id }, 'sessionInteractionService', 'respond', [
        parked.id,
        { decision: 'approved' },
      ]);
      const pendingAfterCross = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'listPending',
        ['approval'],
      )) as readonly { id: string }[];
      expect(pendingAfterCross.map((i) => i.id)).toEqual([parked.id]);

      await dispatcher.call({ sessionId: first.id }, 'sessionInteractionService', 'respond', [
        parked.id,
        { decision: 'approved' },
      ]);
      const pendingAfterOwn = (await dispatcher.call(
        { sessionId: first.id },
        'sessionInteractionService',
        'listPending',
        ['approval'],
      )) as readonly { id: string }[];
      expect(pendingAfterOwn).toEqual([]);
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });
});
