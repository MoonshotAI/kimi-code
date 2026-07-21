import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { SUBAGENT_SECTION, type SubagentConfig } from '#/session/subagent/configSection';
import { ISubagentRoutingService } from '#/session/subagent/subagentRouting';
import { SubagentRoutingService } from '#/session/subagent/subagentRoutingService';

import { stubFlag } from '../../app/flag/stubs';

// ---------------------------------------------------------------------------
// In-memory ISessionMetadata stub — supports pre-seeding custom fields.
// ---------------------------------------------------------------------------

interface InMemoryMetaOptions {
  readonly custom?: Record<string, unknown>;
}

function createInMemoryMetadata(opts: InMemoryMetaOptions = {}): ISessionMetadata {
  let doc: SessionMeta = {
    id: 's1',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    custom: { ...opts.custom },
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None as Event<SessionMetadataChangedEvent>,
    read: async () => ({ ...doc, custom: { ...doc.custom } }),
    update: async (patch: SessionMetaPatch) => {
      doc = { ...doc, ...patch };
    },
    setTitle: async () => {},
    setArchived: async () => {},
    registerAgent: async () => {},
  };
}

// ---------------------------------------------------------------------------
// IConfigService stub — returns a configurable [subagent] section.
// ---------------------------------------------------------------------------

function createConfigStub(subagent?: Partial<SubagentConfig>): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: Event.None,
    onDidSectionChange: Event.None,
    get: <T = unknown>(domain: string): T => {
      if (domain === SUBAGENT_SECTION) {
        return { ...subagent } as T;
      }
      return undefined as T;
    },
    inspect: () => ({}) as never,
    getAll: () => ({}) as never,
    set: async () => {},
    replace: async () => {},
    reload: async () => {},
    diagnostics: () => [],
  } as IConfigService;
}

// ---------------------------------------------------------------------------
// Suite-scoped state — varied per test, rebuilt in beforeEach.
// ---------------------------------------------------------------------------

describe('SubagentRoutingService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  // Per-test knobs (set inside each it or via helpers).
  let flagOn: boolean;
  let configSubagent: Partial<SubagentConfig> | undefined;
  let metaCustom: Record<string, unknown> | undefined;

  function build(): ISubagentRoutingService {
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFlagService, stubFlag(flagOn));
    ix.stub(IConfigService, createConfigStub(configSubagent));
    ix.stub(ISessionMetadata, createInMemoryMetadata({ custom: metaCustom }));
    ix.set(ISubagentRoutingService, new SyncDescriptor(SubagentRoutingService));
    return ix.get(ISubagentRoutingService);
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    flagOn = false;
    configSubagent = undefined;
    metaCustom = undefined;
  });

  afterEach(() => {
    disposables.dispose();
  });

  // -------------------------------------------------------------------------
  // 1. Flag off (default) — parent inheritance.
  // -------------------------------------------------------------------------

  it('returns undefined and inherits parent model/thinking when flag is off', () => {
    flagOn = false;
    const svc = build();

    expect(svc.getSubagentModel()).toBeUndefined();
    expect(svc.getSubagentThinkingEffort()).toBeUndefined();
    expect(svc.resolveChildModel('parent-model')).toBe('parent-model');
    expect(svc.resolveChildThinkingEffort('high')).toBe('high');
  });

  // -------------------------------------------------------------------------
  // 2. Flag on, no override, no config default — still parent inheritance.
  // -------------------------------------------------------------------------

  it('inherits parent values when flag is on but nothing is configured', async () => {
    flagOn = true;
    const svc = build();
    await svc.ready;

    expect(svc.getSubagentModel()).toBeUndefined();
    expect(svc.getSubagentThinkingEffort()).toBeUndefined();
    expect(svc.resolveChildModel('parent-model')).toBe('parent-model');
    expect(svc.resolveChildThinkingEffort('high')).toBe('high');
  });

  // -------------------------------------------------------------------------
  // 3. Flag on, session override — model.
  // -------------------------------------------------------------------------

  it('uses session model override when flag is on', async () => {
    flagOn = true;
    const svc = build();
    await svc.ready;

    await svc.setSubagentModel('kimi-flash');

    expect(svc.getSubagentModel()).toBe('kimi-flash');
    expect(svc.resolveChildModel('kimi-k3')).toBe('kimi-flash');
  });

  // -------------------------------------------------------------------------
  // 4. Flag on, session override — thinking effort.
  // -------------------------------------------------------------------------

  it('uses session thinking-effort override when flag is on', async () => {
    flagOn = true;
    const svc = build();
    await svc.ready;

    await svc.setSubagentThinkingEffort('low');

    expect(svc.getSubagentThinkingEffort()).toBe('low');
    expect(svc.resolveChildThinkingEffort('high')).toBe('low');
  });

  // -------------------------------------------------------------------------
  // 5. Flag on, config default but no session override.
  // -------------------------------------------------------------------------

  it('falls back to config default when flag is on and no session override', async () => {
    flagOn = true;
    configSubagent = { defaultSubagentModel: 'kimi-flash' };
    const svc = build();
    await svc.ready;

    expect(svc.getSubagentModel()).toBe('kimi-flash');
    expect(svc.resolveChildModel('kimi-k3')).toBe('kimi-flash');
  });

  // -------------------------------------------------------------------------
  // 6. Flag on, session override takes priority over config default.
  // -------------------------------------------------------------------------

  it('session override wins over config default', async () => {
    flagOn = true;
    configSubagent = { defaultSubagentModel: 'config-default' };
    const svc = build();
    await svc.ready;

    await svc.setSubagentModel('kimi-flash');

    expect(svc.getSubagentModel()).toBe('kimi-flash');
    expect(svc.resolveChildModel('kimi-k3')).toBe('kimi-flash');
  });

  // -------------------------------------------------------------------------
  // 7. Clearing override via undefined falls back to config default / undefined.
  // -------------------------------------------------------------------------

  it('clearing model override with undefined falls back to config default', async () => {
    flagOn = true;
    configSubagent = { defaultSubagentModel: 'config-default' };
    const svc = build();
    await svc.ready;

    await svc.setSubagentModel('kimi-flash');
    expect(svc.getSubagentModel()).toBe('kimi-flash');

    await svc.setSubagentModel(undefined);
    expect(svc.getSubagentModel()).toBe('config-default');
  });

  it('clearing model override with undefined yields undefined when no config default', async () => {
    flagOn = true;
    const svc = build();
    await svc.ready;

    await svc.setSubagentModel('kimi-flash');
    expect(svc.getSubagentModel()).toBe('kimi-flash');

    await svc.setSubagentModel(undefined);
    expect(svc.getSubagentModel()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8. Empty string is treated as undefined (clears the override).
  // -------------------------------------------------------------------------

  it('treats empty string as undefined when setting model override', async () => {
    flagOn = true;
    configSubagent = { defaultSubagentModel: 'config-default' };
    const svc = build();
    await svc.ready;

    await svc.setSubagentModel('kimi-flash');
    expect(svc.getSubagentModel()).toBe('kimi-flash');

    await svc.setSubagentModel('');
    expect(svc.getSubagentModel()).toBe('config-default');
  });

  it('treats whitespace-only string as undefined when setting model override', async () => {
    flagOn = true;
    const svc = build();
    await svc.ready;

    await svc.setSubagentModel('kimi-flash');
    await svc.setSubagentModel('   ');

    expect(svc.getSubagentModel()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. Persistence to metadata.
  // -------------------------------------------------------------------------

  it('persists model override to session metadata custom.subagentModelAlias', async () => {
    flagOn = true;
    const meta = createInMemoryMetadata();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFlagService, stubFlag(flagOn));
    ix.stub(IConfigService, createConfigStub());
    ix.stub(ISessionMetadata, meta);
    ix.set(ISubagentRoutingService, new SyncDescriptor(SubagentRoutingService));

    const svc = ix.get(ISubagentRoutingService);
    await svc.ready;

    await svc.setSubagentModel('kimi-flash');

    const stored = await meta.read();
    expect(stored.custom?.['subagentModelAlias']).toBe('kimi-flash');
  });

  it('persists thinking-effort override to session metadata custom.subagentThinkingEffort', async () => {
    flagOn = true;
    const meta = createInMemoryMetadata();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFlagService, stubFlag(flagOn));
    ix.stub(IConfigService, createConfigStub());
    ix.stub(ISessionMetadata, meta);
    ix.set(ISubagentRoutingService, new SyncDescriptor(SubagentRoutingService));

    const svc = ix.get(ISubagentRoutingService);
    await svc.ready;

    await svc.setSubagentThinkingEffort('low');

    const stored = await meta.read();
    expect(stored.custom?.['subagentThinkingEffort']).toBe('low');
  });

  // -------------------------------------------------------------------------
  // 10. Load from metadata on construction.
  // -------------------------------------------------------------------------

  it('loads model override from session metadata on construction', async () => {
    flagOn = true;
    metaCustom = { subagentModelAlias: 'kimi-flash' };
    const svc = build();
    await svc.ready;

    expect(svc.getSubagentModel()).toBe('kimi-flash');
    expect(svc.resolveChildModel('kimi-k3')).toBe('kimi-flash');
  });

  it('loads thinking-effort override from session metadata on construction', async () => {
    flagOn = true;
    metaCustom = { subagentThinkingEffort: 'low' };
    const svc = build();
    await svc.ready;

    expect(svc.getSubagentThinkingEffort()).toBe('low');
    expect(svc.resolveChildThinkingEffort('high')).toBe('low');
  });

  it('does not load overrides from metadata when flag is off', async () => {
    flagOn = false;
    metaCustom = { subagentModelAlias: 'kimi-flash' };
    const svc = build();
    await svc.ready;

    expect(svc.getSubagentModel()).toBeUndefined();
    expect(svc.resolveChildModel('kimi-k3')).toBe('kimi-k3');
  });

  // -------------------------------------------------------------------------
  // Bonus: config default for thinking effort + override priority.
  // -------------------------------------------------------------------------

  it('falls back to config default thinking effort and lets session override win', async () => {
    flagOn = true;
    configSubagent = { defaultSubagentThinkingEffort: 'medium' };
    const svc = build();
    await svc.ready;

    expect(svc.getSubagentThinkingEffort()).toBe('medium');

    await svc.setSubagentThinkingEffort('low');
    expect(svc.getSubagentThinkingEffort()).toBe('low');
  });
});
