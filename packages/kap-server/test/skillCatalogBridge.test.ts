/**
 * `SkillCatalogBridge` — volatile `skill_catalog.changed` delivery: one frame
 * per core change fanned out under each connection's own `seq` (no journal
 * epoch), and refcounted release of the core subscription on last detach.
 * Fake core accessor (per `wsConnectionV1.test.ts`); `onDidChange` hand-fired.
 */
import {
  type IDisposable,
  ISessionSkillCatalog,
  ISessionLifecycleService,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import {
  SkillCatalogBridge,
  type SkillCatalogChangedFrame,
  type SkillCatalogConnection,
} from '../src/transport/ws/v1/skillCatalogBridge';
import type { EventEnvelope } from '../src/transport/ws/v1/sessionEventJournal';
import { createSessionLifecycleHooks } from './helpers/sessionEvents';

function makeConn(id: string): { conn: SkillCatalogConnection; frames: SkillCatalogChangedFrame[] } {
  const frames: SkillCatalogChangedFrame[] = [];
  return {
    frames,
    conn: {
      id,
      send: (envelope: EventEnvelope) => frames.push(envelope as unknown as SkillCatalogChangedFrame),
    },
  };
}

interface FakeCatalog {
  readonly service: ISessionSkillCatalog;
  readonly onDidChange: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  fire(sourceId: string): void;
  listenerCount(): number;
}

function makeCatalog(): FakeCatalog {
  let listener: ((sourceId: string) => void) | undefined;
  const dispose = vi.fn(() => {
    listener = undefined;
  });
  const onDidChange = vi.fn((cb: (sourceId: string) => void): IDisposable => {
    listener = cb;
    return { dispose };
  });
  return {
    service: { onDidChange } as unknown as ISessionSkillCatalog,
    onDidChange,
    dispose,
    fire: (sourceId: string) => listener?.(sourceId),
    listenerCount: () => (listener === undefined ? 0 : 1),
  };
}

function makeCore(sessions: Map<string, ISessionScopeHandle>): Scope {
  const hooks = createSessionLifecycleHooks();
  const lifecycle = { get: (sid: string) => sessions.get(sid), hooks };
  return {
    accessor: {
      get: (decorator: unknown) => {
        if (decorator === ISessionLifecycleService) return lifecycle;
        throw new Error('unexpected service lookup');
      },
    },
  } as unknown as Scope;
}

function makeSession(catalog: ISessionSkillCatalog): ISessionScopeHandle {
  return {
    accessor: {
      get: (decorator: unknown) => {
        if (decorator === ISessionSkillCatalog) return catalog;
        throw new Error('unexpected service lookup');
      },
    },
  } as unknown as ISessionScopeHandle;
}

describe('SkillCatalogBridge', () => {
  it('fans one volatile frame per core change out to every subscribed connection', () => {
    const catalog = makeCatalog();
    const sessions = new Map([['sess_1', makeSession(catalog.service)]]);
    const bridge = new SkillCatalogBridge({ core: makeCore(sessions) });
    const a = makeConn('conn_a');
    const b = makeConn('conn_b');

    bridge.attachSession(a.conn, 'sess_1');
    bridge.attachSession(b.conn, 'sess_1');
    // One core subscription shared by both connections of the session.
    expect(catalog.onDidChange).toHaveBeenCalledTimes(1);
    expect(a.frames).toHaveLength(0);
    expect(b.frames).toHaveLength(0);

    catalog.fire('workspace-file');

    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(1);
    for (const frames of [a.frames, b.frames]) {
      const frame = frames[0]!;
      expect(frame).toMatchObject({
        type: 'skill_catalog.changed',
        // Per-connection monotonic seq — not the durable session watermark.
        seq: 1,
        session_id: 'sess_1',
        volatile: true,
        payload: { type: 'skill_catalog.changed', sourceId: 'workspace-file' },
      });
      // No journalling surface: no journal epoch is attached to the frame.
      expect('epoch' in frame).toBe(false);
    }

    // A second change advances each connection's own seq only.
    catalog.fire('plugin');
    expect(a.frames[1]).toMatchObject({ seq: 2, payload: { sourceId: 'plugin' } });
    expect(b.frames[1]).toMatchObject({ seq: 2, payload: { sourceId: 'plugin' } });
  });

  it('stops delivering to an unsubscribed connection and releases the core subscription on last detach', () => {
    const catalog = makeCatalog();
    const sessions = new Map([['sess_1', makeSession(catalog.service)]]);
    const bridge = new SkillCatalogBridge({ core: makeCore(sessions) });
    const a = makeConn('conn_a');
    const b = makeConn('conn_b');

    bridge.attachSession(a.conn, 'sess_1');
    bridge.attachSession(b.conn, 'sess_1');
    bridge.detachSession(a.conn, 'sess_1');
    catalog.fire('workspace-file');

    expect(a.frames).toHaveLength(0);
    expect(b.frames).toHaveLength(1);
    // conn_b still holds the session: core subscription is NOT released.
    expect(catalog.dispose).not.toHaveBeenCalled();

    bridge.detachSession(b.conn, 'sess_1');
    expect(catalog.dispose).toHaveBeenCalledTimes(1);
    expect(catalog.listenerCount()).toBe(0);

    catalog.fire('plugin');
    expect(a.frames).toHaveLength(0);
    expect(b.frames).toHaveLength(1);
  });
});
