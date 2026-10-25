import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  IAgentLifecycleService,
  IAgentTaskService,
  IAtomicDocumentStore,
  IExternalHooksRunnerService,
  IFileSystemStorageService,
  ILogService,
  ISessionContext,
  ISessionIndexMirror,
  ISessionManager,
  ISessionMetadata,
  ITelemetryService,
  IWireService,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '@moonshot-ai/agent-core-v2/_base/errors/unexpectedError';

import { createTestClient, type TestClient } from './_helpers/acpClient';

describe('acp-server session/close', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-close-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it(
    'advertises the close capability and closes a live session',
    async () => {
      const c = await boot();
      const init = (await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} })) as {
        agentCapabilities?: { sessionCapabilities?: { close?: unknown } };
      };
      expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined();

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.send('session/close', { sessionId: created.sessionId });

      // After close the server no longer routes the session — a follow-up
      // prompt must surface invalid_params for the now-unknown sessionId.
      await expect(
        c.send('session/prompt', { sessionId: created.sessionId, prompt: [] }),
      ).rejects.toThrow();
      await c.close();
      await expect(c.close()).resolves.toBeUndefined();
    },
    30_000,
  );

  it.each([false, true])('server close waits for accepted wire dehydration when an earlier agent fails: %s', async (stopFails) => {
    const c = await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let closing: Promise<void> | undefined;
    let wire: IWireService | undefined;
    let restoreAppend = () => {};
    const unexpected: unknown[] = [];
    try {
      const created = await c.send('session/new', { cwd: homeDir, mcpServers: [] }) as { sessionId: string };
      const session = c.server.core.accessor.get(ISessionManager).get(created.sessionId)!;
      const agents = session.accessor.get(IAgentLifecycleService);
      if (agents.handleOf(MAIN_AGENT_ID) === undefined) {
        await agents.create({ agentId: MAIN_AGENT_ID });
      }
      if (stopFails) {
        await agents.create({ agentId: 'aux' });
        vi.spyOn(agents.handleOf(MAIN_AGENT_ID)!.accessor.get(IAgentTaskService), 'stopAllOnExit')
          .mockRejectedValue(new Error('stop failed'));
      }
      wire = agents.handleOf(stopFails ? 'aux' : MAIN_AGENT_ID)!.accessor.get(IWireService);
      const removed = vi.spyOn(agents, 'remove');
      const warning = vi.spyOn(c.server.core.accessor.get(ILogService), 'warn');
      const hooks = vi.spyOn(c.server.core.accessor.get(IExternalHooksRunnerService), 'trigger');
      const sessionClosed = vi.fn();
      c.server.core.accessor.get(ISessionManager).onDidCloseSession!(sessionClosed);
      const telemetryEvents: string[] = [];
      const telemetry = c.server.core.accessor.get(ITelemetryService);
      telemetry.setEnabled(true);
      telemetry.addAppender({ track: (record) => { telemetryEvents.push(record.event); } });
      await wire.flush();
      const wirePath = wire.journalPath()!;
      const appended = vi.spyOn(c.server.core.accessor.get(IFileSystemStorageService), 'append');
      restoreAppend = () => { appended.mockRestore(); };
      setUnexpectedErrorHandler((error) => unexpected.push(error));
      wire.appendRecord({ type: 'test.shutdown.marker' }, async (record) => {
        markStarted();
        await gate;
        return { ...record, marker: 'dehydrated-before-close' };
      });
      await started;
      let closed = false;
      let writesAtClose = 0;
      closing = c.close().then(() => {
        closed = true;
        writesAtClose = appended.mock.calls.length;
      });
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect.soft(closed).toBe(false);
      release();
      await closing;
      await wire.drainPersisted();

      const bytes = await readFile(wirePath, 'utf8');
      const records = bytes.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect.soft(records.filter((record) => record.type === 'test.shutdown.marker')).toEqual([{
        type: 'test.shutdown.marker',
        marker: 'dehydrated-before-close',
      }]);
      expect(removed.mock.calls.map(([agent]) => agent.agentId)).toEqual(stopFails ? [MAIN_AGENT_ID, 'aux'] : [MAIN_AGENT_ID]);
      expect(hooks.mock.calls.filter(([event]) => event === 'SessionEnd')).toEqual([]);
      expect(sessionClosed).not.toHaveBeenCalled();
      expect(telemetryEvents).not.toContain('session_ended');
      if (stopFails) {
        expect(warning).toHaveBeenCalledWith('agent removal failed; continuing shutdown', {
          sessionId: session.id,
          agentId: MAIN_AGENT_ID,
          error: expect.objectContaining({ message: 'stop failed' }),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(appended).toHaveBeenCalledTimes(writesAtClose);
      expect(await readFile(wirePath, 'utf8')).toBe(bytes);
      expect(unexpected).toEqual([]);
    } finally {
      release();
      try {
        if (closing !== undefined) await closing;
        else await c.close();
        await wire?.drainPersisted();
      } finally {
        restoreAppend();
        resetUnexpectedErrorHandler();
      }
    }
  }, 30_000);

  it('server close waits for a session close already flushing accepted wire dehydration', async () => {
    const c = await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markFlushing!: () => void;
    const flushing = new Promise<void>((resolve) => { markFlushing = resolve; });
    let sessionClosing: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let wire: IWireService | undefined;
    let restoreSpies = () => {};
    const unexpected: unknown[] = [];
    try {
      const created = await c.send('session/new', { cwd: homeDir, mcpServers: [] }) as { sessionId: string };
      const sessionManager = c.server.core.accessor.get(ISessionManager);
      const session = sessionManager.get(created.sessionId)!;
      const agents = session.accessor.get(IAgentLifecycleService);
      if (agents.handleOf(MAIN_AGENT_ID) === undefined) {
        await agents.create({ agentId: MAIN_AGENT_ID });
      }
      wire = agents.handleOf(MAIN_AGENT_ID)!.accessor.get(IWireService);
      await wire.flush();
      const wirePath = wire.journalPath()!;
      const flush = wire.flush.bind(wire);
      const flushingWire = vi.spyOn(wire, 'flush').mockImplementation(() => {
        markFlushing();
        return flush();
      });
      const appended = vi.spyOn(c.server.core.accessor.get(IFileSystemStorageService), 'append');
      restoreSpies = () => {
        flushingWire.mockRestore();
        appended.mockRestore();
      };
      const closedSession = vi.fn();
      sessionManager.onDidCloseSession!(closedSession);
      setUnexpectedErrorHandler((error) => unexpected.push(error));
      wire.appendRecord({ type: 'test.shutdown.marker' }, async (record) => {
        markStarted();
        await gate;
        return { ...record, marker: 'dehydrated-during-session-close' };
      });
      await started;
      sessionClosing = sessionManager.close(session.id);
      void sessionClosing.catch(() => {});
      await flushing;
      expect(agents.list()).toEqual([]);
      expect(sessionManager.get(session.id)).toBe(session);

      let closed = false;
      let writesAtClose = 0;
      closing = c.close().then(() => {
        closed = true;
        writesAtClose = appended.mock.calls.length;
      });
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect(closed).toBe(false);
      release();
      await sessionClosing;
      await closing;
      await wire.drainPersisted();

      const bytes = await readFile(wirePath, 'utf8');
      const records = bytes.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(records.filter((record) => record.type === 'test.shutdown.marker')).toEqual([{
        type: 'test.shutdown.marker',
        marker: 'dehydrated-during-session-close',
      }]);
      expect(closedSession).toHaveBeenCalledOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(appended).toHaveBeenCalledTimes(writesAtClose);
      expect(await readFile(wirePath, 'utf8')).toBe(bytes);
      expect(unexpected).toEqual([]);
    } finally {
      release();
      try {
        if (closing !== undefined) await closing;
        else await c.close();
        await Promise.race([
          sessionClosing?.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
        await wire?.drainPersisted();
      } finally {
        restoreSpies();
        resetUnexpectedErrorHandler();
      }
    }
  }, 30_000);

  it('server close settles session metadata before draining the session-index mirror', async () => {
    const c = await boot();
    const created = await c.send('session/new', { cwd: homeDir, mcpServers: [] }) as { sessionId: string };
    const session = c.server.core.accessor.get(ISessionManager).get(created.sessionId)!;
    const context = session.accessor.get(ISessionContext);
    const documents = c.server.core.accessor.get(IAtomicDocumentStore);
    const set = documents.set.bind(documents);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const write = vi.spyOn(documents, 'set').mockImplementation(async (scope, key, value) => {
      if (scope === context.metaScope && key === 'state.json') {
        started();
        await gate;
      }
      await set(scope, key, value);
    });
    const mirror = c.server.core.accessor.get(ISessionIndexMirror);
    const drain = vi.spyOn(mirror, 'drain');
    const record = vi.spyOn(mirror, 'record');
    const updating = session.accessor.get(ISessionMetadata).setTitle('Metadata before shutdown');
    await writing;
    let closed = false;
    const closing = c.close().then(() => { closed = true; });
    try {
      await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect.soft(closed).toBe(false);
      expect.soft(drain).not.toHaveBeenCalled();
    } finally {
      release();
      await updating;
      await closing;
      write.mockRestore();
    }
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ title: 'Metadata before shutdown' }));
    expect(drain).toHaveBeenCalled();
  }, 30_000);

  it(
    'closing an unknown sessionId is a best-effort no-op',
    async () => {
      const c = await boot();
      await expect(c.send('session/close', { sessionId: 'does-not-exist' })).resolves.toEqual({});
    },
    30_000,
  );
});
