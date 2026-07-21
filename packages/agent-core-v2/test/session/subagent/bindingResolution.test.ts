import { describe, expect, it, vi } from 'vitest';

import { IWorkspaceLocalConfigService, type SubagentBinding } from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { type IModelCatalog, type Model } from '#/kosong/model/catalog';
import { resolveSubagentSpawnBinding } from '#/session/subagent/bindingResolution';

import { stubFlag } from '../../app/flag/stubs';

const WORK_DIR = '/repo/work';

interface BindingTables {
  readonly bindings?: Readonly<Record<string, SubagentBinding>>;
  readonly slotBindings?: Readonly<Record<string, SubagentBinding>>;
}

function makeDeps(options: {
  readonly flagEnabled?: boolean;
  readonly tables?: BindingTables;
  readonly validAliases?: readonly string[];
} = {}) {
  const bindings = new Map(Object.entries(options.tables?.bindings ?? {}));
  const slotBindings = new Map(Object.entries(options.tables?.slotBindings ?? {}));
  const workspaceLocalConfig = {
    _serviceBrand: undefined,
    readSubagentBinding: vi.fn(async (_workDir: string, agentType: string) =>
      bindings.get(agentType),
    ),
    readSubagentSlotBinding: vi.fn(async (_workDir: string, slot: string) =>
      slotBindings.get(slot),
    ),
  };
  const validAliases = new Set(options.validAliases ?? []);
  const modelCatalog = {
    _serviceBrand: undefined,
    get: vi.fn((alias: string): Model => {
      if (!validAliases.has(alias)) throw new Error(`model.not_configured: ${alias}`);
      return {} as Model;
    }),
  };
  return {
    deps: {
      flags: stubFlag(options.flagEnabled ?? true),
      workspaceLocalConfig: workspaceLocalConfig as unknown as IWorkspaceLocalConfigService,
      modelCatalog: modelCatalog as unknown as IModelCatalog,
    },
    workspaceLocalConfig,
    modelCatalog,
  };
}

describe('resolveSubagentSpawnBinding', () => {
  it('returns an empty resolution when the experimental flag is disabled', async () => {
    const { deps, workspaceLocalConfig } = makeDeps({
      flagEnabled: false,
      tables: { bindings: { coder: { model: 'sub/model' } } },
      validAliases: ['sub/model'],
    });

    await expect(
      resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
        bindingSlot: 'fast',
      }),
    ).resolves.toEqual({});
    expect(workspaceLocalConfig.readSubagentBinding).not.toHaveBeenCalled();
    expect(workspaceLocalConfig.readSubagentSlotBinding).not.toHaveBeenCalled();
  });

  it('prefers the slot binding over the type binding', async () => {
    const { deps } = makeDeps({
      tables: {
        bindings: { coder: { model: 'type/model', thinkingEffort: 'low' } },
        slotBindings: { fast: { model: 'slot/model', thinkingEffort: 'high' } },
      },
      validAliases: ['type/model', 'slot/model'],
    });

    await expect(
      resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
        bindingSlot: 'fast',
      }),
    ).resolves.toEqual({ model: 'slot/model', thinking: 'high' });
  });

  it('uses the type binding when no slot is requested', async () => {
    const { deps } = makeDeps({
      tables: { bindings: { coder: { model: 'type/model', thinkingEffort: 'high' } } },
      validAliases: ['type/model'],
    });

    await expect(
      resolveSubagentSpawnBinding(deps, { workDir: WORK_DIR, profileName: 'coder' }),
    ).resolves.toEqual({ model: 'type/model', thinking: 'high' });
  });

  it('falls back silently to the type binding when the slot entry is missing', async () => {
    const { deps } = makeDeps({
      tables: { bindings: { coder: { model: 'type/model' } } },
      validAliases: ['type/model'],
    });

    await expect(
      resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
        bindingSlot: 'never-configured',
      }),
    ).resolves.toEqual({ model: 'type/model' });
  });

  it('treats inherit as an explicit choice and never falls back', async () => {
    const { deps, workspaceLocalConfig } = makeDeps({
      tables: {
        bindings: { coder: { model: 'type/model' } },
        slotBindings: { fast: { inherit: true } },
      },
      validAliases: ['type/model'],
    });

    await expect(
      resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
        bindingSlot: 'fast',
      }),
    ).resolves.toEqual({});
    expect(workspaceLocalConfig.readSubagentBinding).not.toHaveBeenCalled();
  });

  it('warns and falls back to the type binding when the slot alias is stale', async () => {
    const { deps } = makeDeps({
      tables: {
        bindings: { coder: { model: 'type/model' } },
        slotBindings: { fast: { model: 'gone/model' } },
      },
      validAliases: ['type/model'],
    });

    const resolution = await resolveSubagentSpawnBinding(deps, {
      workDir: WORK_DIR,
      profileName: 'coder',
      bindingSlot: 'fast',
    });

    expect(resolution.model).toBe('type/model');
    expect(resolution.warning).toContain('subagent-slot.fast');
    expect(resolution.warning).toContain('gone/model');
  });

  it('warns and inherits the caller model when the type alias is stale', async () => {
    const { deps } = makeDeps({
      tables: { bindings: { coder: { model: 'gone/model' } } },
      validAliases: [],
    });

    const resolution = await resolveSubagentSpawnBinding(deps, {
      workDir: WORK_DIR,
      profileName: 'coder',
    });

    expect(resolution.model).toBeUndefined();
    expect(resolution.warning).toContain('subagent.coder');
    expect(resolution.warning).toContain('gone/model');
  });

  it('passes a thinking-only entry through without consulting the catalog', async () => {
    const { deps, modelCatalog } = makeDeps({
      tables: { bindings: { coder: { thinkingEffort: 'high' } } },
      validAliases: [],
    });

    await expect(
      resolveSubagentSpawnBinding(deps, { workDir: WORK_DIR, profileName: 'coder' }),
    ).resolves.toEqual({ thinking: 'high' });
    expect(modelCatalog.get).not.toHaveBeenCalled();
  });

  it('keeps the slot warning when the fallback chain ends in inherit', async () => {
    const { deps } = makeDeps({
      tables: { slotBindings: { fast: { model: 'gone/model' } } },
      validAliases: [],
    });

    const resolution = await resolveSubagentSpawnBinding(deps, {
      workDir: WORK_DIR,
      profileName: 'coder',
      bindingSlot: 'fast',
    });

    expect(resolution.model).toBeUndefined();
    expect(resolution.warning).toContain('subagent-slot.fast');
  });
});
