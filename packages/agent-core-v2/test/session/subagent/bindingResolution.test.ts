import { describe, expect, it, vi } from 'vitest';

import { IWorkspaceLocalConfigService, type SubagentBinding } from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { type IModelCatalog, type Model } from '#/kosong/model/catalog';
import {
  type AskSubagentSpawnBindingCallback,
  resolveSubagentSpawnBinding,
} from '#/session/subagent/bindingResolution';

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
  readonly ask?: AskSubagentSpawnBindingCallback;
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
      ask: options.ask,
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

    const resolution = await resolveSubagentSpawnBinding(deps, {
      workDir: WORK_DIR,
      profileName: 'coder',
      bindingSlot: 'fast',
    });

    expect(resolution).toEqual({});
    expect(resolution.warning).toBeUndefined();
    expect(workspaceLocalConfig.readSubagentBinding).not.toHaveBeenCalled();
  });

  it('warns and keeps inheriting when an inherit slot entry also sets model or thinking_effort', async () => {
    const { deps, workspaceLocalConfig, modelCatalog } = makeDeps({
      tables: {
        bindings: { coder: { model: 'type/model' } },
        slotBindings: { fast: { inherit: true, model: 'slot/model', thinkingEffort: 'high' } },
      },
      validAliases: ['type/model', 'slot/model'],
    });

    const resolution = await resolveSubagentSpawnBinding(deps, {
      workDir: WORK_DIR,
      profileName: 'coder',
      bindingSlot: 'fast',
    });

    expect(resolution).toEqual({
      warning: expect.stringContaining('inherit=true'),
    });
    expect(resolution.warning).toContain('subagent-slot.fast');
    expect(resolution.warning).toContain('model and thinking_effort');
    expect(modelCatalog.get).not.toHaveBeenCalled();
    expect(workspaceLocalConfig.readSubagentBinding).not.toHaveBeenCalled();
  });

  it('warns about the ignored model when an inherit type entry also sets model', async () => {
    const { deps, modelCatalog } = makeDeps({
      tables: { bindings: { coder: { inherit: true, model: 'gone/model' } } },
      validAliases: [],
    });

    const resolution = await resolveSubagentSpawnBinding(deps, {
      workDir: WORK_DIR,
      profileName: 'coder',
    });

    expect(resolution.warning).toContain('subagent.coder');
    expect(resolution.warning).toContain('inherit=true');
    expect(resolution.warning).toContain('model');
    expect(resolution.warning).not.toContain('thinking_effort');
    expect(modelCatalog.get).not.toHaveBeenCalled();
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
    expect(resolution.warning).toContain('not configured or cannot be resolved');
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

  it('never asks and inherits when nothing is bound and no ask callback is supplied', async () => {
    const { deps, workspaceLocalConfig } = makeDeps({ validAliases: [] });

    await expect(
      resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
        bindingSlot: 'fast',
      }),
    ).resolves.toEqual({});
    expect(workspaceLocalConfig.readSubagentSlotBinding).toHaveBeenCalledOnce();
    expect(workspaceLocalConfig.readSubagentBinding).toHaveBeenCalledOnce();
  });

  describe('interactive ask-once', () => {
    it('asks once for a missing type binding and adopts the answer without re-validation', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => ({
        model: 'asked/model',
        thinkingEffort: 'high',
      }));
      const { deps, modelCatalog } = makeDeps({ ask, validAliases: [] });

      await expect(
        resolveSubagentSpawnBinding(deps, { workDir: WORK_DIR, profileName: 'coder' }),
      ).resolves.toEqual({ model: 'asked/model', thinking: 'high' });
      expect(ask).toHaveBeenCalledWith('coder', undefined);
      expect(modelCatalog.get).not.toHaveBeenCalled();
    });

    it('adopts an inherit answer for a slot as terminal without reading the type binding', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => ({ inherit: true }));
      const { deps, workspaceLocalConfig } = makeDeps({
        ask,
        tables: { bindings: { coder: { model: 'type/model' } } },
        validAliases: ['type/model'],
      });

      await expect(
        resolveSubagentSpawnBinding(deps, {
          workDir: WORK_DIR,
          profileName: 'coder',
          bindingSlot: 'fast',
        }),
      ).resolves.toEqual({});
      expect(ask).toHaveBeenCalledWith('coder', { slot: 'fast' });
      expect(workspaceLocalConfig.readSubagentBinding).not.toHaveBeenCalled();
    });

    it('asks for a missing slot with the slot context and adopts the answer', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => ({ model: 'slot/model' }));
      const { deps } = makeDeps({ ask, validAliases: [] });

      await expect(
        resolveSubagentSpawnBinding(deps, {
          workDir: WORK_DIR,
          profileName: 'coder',
          bindingSlot: 'fast',
        }),
      ).resolves.toEqual({ model: 'slot/model' });
      expect(ask).toHaveBeenCalledWith('coder', { slot: 'fast' });
    });

    it('falls back to the type binding when the slot ask is dismissed', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => undefined);
      const { deps } = makeDeps({
        ask,
        tables: { bindings: { coder: { model: 'type/model' } } },
        validAliases: ['type/model'],
      });

      await expect(
        resolveSubagentSpawnBinding(deps, {
          workDir: WORK_DIR,
          profileName: 'coder',
          bindingSlot: 'fast',
        }),
      ).resolves.toEqual({ model: 'type/model' });
      expect(ask).toHaveBeenCalledOnce();
      expect(ask).toHaveBeenCalledWith('coder', { slot: 'fast' });
    });

    it('never asks twice in one spawn: a dismissed slot ask suppresses the type ask', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => undefined);
      const { deps } = makeDeps({ ask, validAliases: [] });

      const resolution = await resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
        bindingSlot: 'fast',
      });

      expect(resolution).toEqual({});
      expect(ask).toHaveBeenCalledOnce();
      expect(ask).toHaveBeenCalledWith('coder', { slot: 'fast' });
    });

    it('keeps the stale-slot warning and skips the type ask after a dismissed repair ask', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => undefined);
      const { deps } = makeDeps({
        ask,
        tables: {
          bindings: { coder: { model: 'gone/type' } },
          slotBindings: { fast: { model: 'gone/slot' } },
        },
        validAliases: [],
      });

      const resolution = await resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
        bindingSlot: 'fast',
      });

      expect(resolution.model).toBeUndefined();
      expect(resolution.warning).toContain('subagent-slot.fast');
      expect(resolution.warning).toContain('gone/slot');
      expect(resolution.warning).toContain('subagent.coder');
      expect(resolution.warning).toContain('gone/type');
      expect(ask).toHaveBeenCalledOnce();
      expect(ask).toHaveBeenCalledWith('coder', { slot: 'fast', missingModel: 'gone/slot' });
    });

    it('inherits silently when the type ask is dismissed', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => undefined);
      const { deps } = makeDeps({ ask, validAliases: [] });

      const resolution = await resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
      });

      expect(resolution).toEqual({});
      expect(ask).toHaveBeenCalledWith('coder', undefined);
    });

    it('asks to repair a stale type binding with the missing model context', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => ({ model: 'fixed/model' }));
      const { deps } = makeDeps({
        ask,
        tables: { bindings: { coder: { model: 'gone/model' } } },
        validAliases: [],
      });

      const resolution = await resolveSubagentSpawnBinding(deps, {
        workDir: WORK_DIR,
        profileName: 'coder',
      });

      expect(resolution).toEqual({ model: 'fixed/model' });
      expect(ask).toHaveBeenCalledWith('coder', { missingModel: 'gone/model' });
    });

    it('keeps the warning when the stale type repair is dismissed', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => undefined);
      const { deps } = makeDeps({
        ask,
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

    it('asks to repair a stale slot binding with slot and missing model context', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => ({ model: 'fixed/model' }));
      const { deps } = makeDeps({
        ask,
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

      expect(resolution).toEqual({ model: 'fixed/model' });
      expect(ask).toHaveBeenCalledWith('coder', { slot: 'fast', missingModel: 'gone/model' });
    });

    it('falls back to the type binding when the stale slot repair is dismissed', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => undefined);
      const { deps } = makeDeps({
        ask,
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

    it('does not ask when the flag is disabled even with an ask callback supplied', async () => {
      const ask = vi.fn<AskSubagentSpawnBindingCallback>(async () => ({ model: 'asked/model' }));
      const { deps } = makeDeps({ flagEnabled: false, ask, validAliases: [] });

      await expect(
        resolveSubagentSpawnBinding(deps, { workDir: WORK_DIR, profileName: 'coder' }),
      ).resolves.toEqual({});
      expect(ask).not.toHaveBeenCalled();
    });
  });
});
