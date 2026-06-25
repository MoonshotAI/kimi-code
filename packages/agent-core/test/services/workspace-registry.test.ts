import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Emitter } from '../../src';
import type { Event } from '@moonshot-ai/protocol';
import type { IEnvironmentService } from '../../src/services/environment/environment';
import type { IEventService } from '../../src/services/event/event';
import type { ILogService } from '../../src/services/logger/logger';
import { WorkspaceRegistryService } from '../../src/services/workspace/workspaceRegistryService';
import { appendSessionIndexEntry } from '../../src/session/store/session-index';
import { encodeWorkDirKey } from '../../src/session/store/workdir-key';

function makeLogger(): ILogService {
  const noop = (): void => {};
  return {
    _serviceBrand: undefined,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => makeLogger(),
  };
}

function makeEventService(): IEventService & { events: Event[] } {
  const emitter = new Emitter<Event>();
  const events: Event[] = [];
  return {
    _serviceBrand: undefined,
    events,
    onDidPublish: emitter.event,
    publish: (event: Event) => {
      events.push(event);
      emitter.fire(event);
    },
  };
}

interface TestContext {
  homeDir: string;
  registry: WorkspaceRegistryService;
}

describe('WorkspaceRegistryService', () => {
  let ctx: TestContext;
  let tempRoots: string[] = [];

  beforeEach(async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-ws-home-'));
    const env: IEnvironmentService = {
      _serviceBrand: undefined,
      homeDir,
      configPath: join(homeDir, 'config.toml'),
    };
    ctx = {
      homeDir,
      registry: new WorkspaceRegistryService(env, makeLogger(), makeEventService()),
    };
    tempRoots = [];
  });

  afterEach(async () => {
    await rm(ctx.homeDir, { recursive: true, force: true });
    for (const root of tempRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function makeProjectRoot(label: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kimi-ws-${label}-`));
    tempRoots.push(root);
    // realpath so resolve() and realpath() agree on the workDir key even when
    // tmpdir() is symlinked (e.g. /tmp -> /private/tmp on macOS).
    return realpath(root);
  }

  async function seedSessionBucket(root: string, sessionId: string): Promise<void> {
    const key = encodeWorkDirKey(root);
    const sessionDir = join(ctx.homeDir, 'sessions', key, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({ archived: false }),
      'utf-8',
    );
    await appendSessionIndexEntry(ctx.homeDir, {
      sessionId,
      sessionDir,
      workDir: root,
    });
  }

  it('auto-registers a workspace for a session bucket missing from the registry', async () => {
    const registeredRoot = await makeProjectRoot('reg');
    const derivedRoot = await makeProjectRoot('derived');

    await ctx.registry.createOrTouch(registeredRoot);
    // derivedRoot has a session bucket + index entry but is NOT registered.
    await seedSessionBucket(derivedRoot, 'sess-derived-1');

    const list = await ctx.registry.list();
    const roots = list.map((w) => w.root);

    expect(roots).toContain(registeredRoot);
    expect(roots).toContain(derivedRoot);

    const derived = list.find((w) => w.root === derivedRoot);
    expect(derived).toBeDefined();
    expect(derived?.session_count).toBe(1);
  });

  it('does not duplicate an already-registered workspace', async () => {
    const root = await makeProjectRoot('only');
    await ctx.registry.createOrTouch(root);
    // A bucket for the same root exists, but it is already registered.
    await seedSessionBucket(root, 'sess-only-1');

    const list = await ctx.registry.list();
    const matches = list.filter((w) => w.root === root);
    expect(matches).toHaveLength(1);
  });

  it('skips a derived bucket whose root no longer exists on disk', async () => {
    const registeredRoot = await makeProjectRoot('live');
    await ctx.registry.createOrTouch(registeredRoot);

    // Point the index at a root that was never created on disk.
    const goneRoot = join(tmpdir(), 'kimi-ws-gone-never-created');
    await seedSessionBucket(goneRoot, 'sess-gone-1');

    const list = await ctx.registry.list();
    const roots = list.map((w) => w.root);

    expect(roots).toContain(registeredRoot);
    expect(roots).not.toContain(goneRoot);
  });

  it('does not re-register a deleted workspace that still has sessions', async () => {
    const root = await makeProjectRoot('deleted');
    const ws = await ctx.registry.createOrTouch(root);
    // Session bucket + index entry remain on disk after the registry entry is removed.
    await seedSessionBucket(root, 'sess-del-1');

    await ctx.registry.delete(ws.id);

    const list = await ctx.registry.list();
    expect(list.map((w) => w.root)).not.toContain(root);
  });

  it('re-adding a previously deleted workspace clears its tombstone', async () => {
    const root = await makeProjectRoot('readd');
    const ws = await ctx.registry.createOrTouch(root);
    await seedSessionBucket(root, 'sess-readd-1');
    await ctx.registry.delete(ws.id);

    // Explicit re-add should bring it back (clears the tombstone).
    await ctx.registry.createOrTouch(root);

    const list = await ctx.registry.list();
    expect(list.map((w) => w.root)).toContain(root);
  });
});
