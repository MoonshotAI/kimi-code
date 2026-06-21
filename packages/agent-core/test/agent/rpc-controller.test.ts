import { describe, expect, it, vi } from 'vitest';

import { AgentRpcController, type AgentRpcHost } from '../../src/agent/rpc-controller';
import type { IBackgroundService } from '../../src/agent/background';
import type { ICompactionService } from '../../src/agent/compaction';
import type { IAgentConfigService } from '../../src/agent/config';
import type { IContextService } from '../../src/agent/context';
import type { IGoalService } from '../../src/agent/goal';
import type { IPermissionService } from '../../src/agent/permission';
import type { IPlanService } from '../../src/agent/plan';
import type { IAgentSkillService } from '../../src/agent/skill';
import type { ISwarmService } from '../../src/agent/swarm';
import type { IAgentToolService } from '../../src/agent/tool/index';
import type { ITurnService } from '../../src/agent/turn';
import type { IUsageService } from '../../src/agent/usage';
import type { ModelProvider } from '../../src/session/provider-manager';
import type { ISubagentHostService } from '../../src/session/subagent-host';
import type { TelemetryClient, TelemetryProperties } from '../../src/telemetry';

interface TelemetryCall {
  readonly event: string;
  readonly properties?: TelemetryProperties;
}

interface HostHarness {
  readonly host: AgentRpcHost;
  readonly controller: AgentRpcController;
  readonly telemetryCalls: TelemetryCall[];
  readonly turn: {
    readonly prompt: ReturnType<typeof vi.fn>;
    readonly steer: ReturnType<typeof vi.fn>;
    readonly cancel: ReturnType<typeof vi.fn>;
  };
  readonly config: {
    readonly update: ReturnType<typeof vi.fn>;
    thinkingLevel: string;
    modelAlias: string | undefined;
  };
  readonly permission: {
    readonly setMode: ReturnType<typeof vi.fn>;
    mode: string;
  };
  readonly modelProvider: {
    readonly resolveProviderConfig: ReturnType<typeof vi.fn>;
  };
  readonly fullCompaction: {
    readonly begin: ReturnType<typeof vi.fn>;
    readonly cancel: ReturnType<typeof vi.fn>;
    isCompacting: boolean;
  };
  readonly skills: { readonly activate: ReturnType<typeof vi.fn> } | null;
}

function makeHost(
  options: { readonly skills?: 'present' | 'null' } = {},
): HostHarness {
  const telemetryCalls: TelemetryCall[] = [];
  const telemetry: TelemetryClient = {
    track: (event, properties) => {
      telemetryCalls.push({ event, properties });
    },
  };

  const turn = {
    prompt: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    hasActiveTurn: false,
  };
  const config = {
    thinkingLevel: 'off',
    modelAlias: undefined as string | undefined,
    update: vi.fn((patch: { thinkingLevel?: string; modelAlias?: string }) => {
      if (patch.thinkingLevel !== undefined) config.thinkingLevel = patch.thinkingLevel;
      if (patch.modelAlias !== undefined) config.modelAlias = patch.modelAlias;
    }),
    data: vi.fn(),
  };
  const permission = {
    mode: 'manual',
    setMode: vi.fn((mode: string) => {
      permission.mode = mode;
    }),
    data: vi.fn(),
  };
  const modelProvider = {
    resolveProviderConfig: vi.fn(() => ({ providerName: 'test-provider' })),
  };
  const fullCompaction = {
    begin: vi.fn(),
    cancel: vi.fn(),
    isCompacting: false,
  };
  const skills =
    options.skills === 'null' ? null : { activate: vi.fn() };

  const host: AgentRpcHost = {
    turn: turn as unknown as ITurnService,
    telemetry,
    context: {
      undo: vi.fn(),
      clear: vi.fn(),
      data: vi.fn(),
    } as unknown as IContextService,
    config: config as unknown as IAgentConfigService,
    permission: permission as unknown as IPermissionService,
    modelProvider: modelProvider as unknown as ModelProvider,
    planMode: {
      enter: vi.fn(async () => {}),
      cancel: vi.fn(),
      clear: vi.fn(),
      data: vi.fn(),
    } as unknown as IPlanService,
    swarmMode: {
      enter: vi.fn(),
      exit: vi.fn(),
      isActive: false,
    } as unknown as ISwarmService,
    fullCompaction: fullCompaction as unknown as ICompactionService,
    tools: {
      registerUserTool: vi.fn(),
      unregisterUserTool: vi.fn(),
      setActiveTools: vi.fn(),
      data: vi.fn(),
    } as unknown as IAgentToolService,
    background: {
      stop: vi.fn(async () => {}),
      readOutput: vi.fn(),
      list: vi.fn(),
    } as unknown as IBackgroundService,
    skills: skills as unknown as IAgentSkillService | null,
    subagentHost: { startBtw: vi.fn() } as unknown as ISubagentHostService,
    goal: {
      createGoal: vi.fn(),
      getGoal: vi.fn(),
      pauseGoal: vi.fn(),
      resumeGoal: vi.fn(),
      cancelGoal: vi.fn(),
    } as unknown as IGoalService,
    usage: { data: vi.fn() } as unknown as IUsageService,
  };

  return {
    host,
    controller: new AgentRpcController(host),
    telemetryCalls,
    turn: { prompt: turn.prompt, steer: turn.steer, cancel: turn.cancel },
    config,
    permission,
    modelProvider,
    fullCompaction,
    skills,
  };
}

describe('AgentRpcController', () => {
  it('delegates prompt / steer / cancel to the turn service with the right arguments', () => {
    const { controller, turn, telemetryCalls } = makeHost();
    const methods = controller.rpcMethods;

    methods.prompt({ input: [{ type: 'text', text: 'hi' }] } as never);
    methods.steer({ input: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } as never);
    methods.cancel({ turnId: 7 } as never);

    expect(turn.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hi' }]);
    expect(turn.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    expect(turn.cancel).toHaveBeenCalledWith(7);
    // steer always tracks input_steer with the number of parts; cancel does not
    // track when there is no active turn.
    expect(telemetryCalls).toEqual([{ event: 'input_steer', properties: { parts: 2 } }]);
  });

  it('tracks cancel streaming telemetry only when a turn is active', () => {
    const harness = makeHost();
    const activeMethods = harness.controller.rpcMethods;
    (harness.host.turn as { hasActiveTurn: boolean }).hasActiveTurn = true;
    activeMethods.cancel({ turnId: 1 } as never);

    const idleHarness = makeHost();
    idleHarness.controller.rpcMethods.cancel({ turnId: 2 } as never);

    expect(harness.telemetryCalls).toEqual([
      { event: 'cancel', properties: { from: 'streaming' } },
    ]);
    expect(idleHarness.telemetryCalls).toEqual([]);
  });

  it('tracks thinking_toggle only when the effective enabled state changes', () => {
    const harness = makeHost();
    const methods = harness.controller.rpcMethods;

    // off -> on: should fire with enabled=true
    methods.setThinking({ level: 'low' } as never);
    expect(harness.config.update).toHaveBeenCalledWith({ thinkingLevel: 'low' });
    expect(harness.telemetryCalls).toEqual([
      { event: 'thinking_toggle', properties: { enabled: true } },
    ]);

    // low -> high: still enabled both before and after, no extra event
    harness.telemetryCalls.length = 0;
    methods.setThinking({ level: 'high' } as never);
    expect(harness.telemetryCalls).toEqual([]);

    // high -> off: enabled flips to false
    methods.setThinking({ level: 'off' } as never);
    expect(harness.telemetryCalls).toEqual([
      { event: 'thinking_toggle', properties: { enabled: false } },
    ]);
  });

  it('tracks yolo_toggle / afk_toggle based on permission transitions', () => {
    const harness = makeHost();
    const methods = harness.controller.rpcMethods;

    methods.setPermission({ mode: 'yolo' } as never);
    expect(harness.telemetryCalls).toEqual([
      { event: 'yolo_toggle', properties: { enabled: true } },
    ]);

    harness.telemetryCalls.length = 0;
    methods.setPermission({ mode: 'auto' } as never);
    expect(harness.telemetryCalls).toEqual([
      { event: 'yolo_toggle', properties: { enabled: false } },
      { event: 'afk_toggle', properties: { enabled: true } },
    ]);
  });

  it('setModel resolves the provider, updates config, and tracks model_switch on change', () => {
    const harness = makeHost();
    harness.config.modelAlias = 'old-model';
    const methods = harness.controller.rpcMethods;

    const result = methods.setModel({ model: 'new-model' } as never);

    expect(harness.modelProvider.resolveProviderConfig).toHaveBeenCalledWith('new-model');
    expect(harness.config.update).toHaveBeenCalledWith({ modelAlias: 'new-model' });
    expect(harness.telemetryCalls).toEqual([
      { event: 'model_switch', properties: { model: 'new-model' } },
    ]);
    expect(result).toEqual({ model: 'new-model', providerName: 'test-provider' });
  });

  it('setModel skips config update + telemetry when the alias is unchanged', () => {
    const harness = makeHost();
    harness.config.modelAlias = 'same-model';
    const methods = harness.controller.rpcMethods;

    methods.setModel({ model: 'same-model' } as never);

    expect(harness.modelProvider.resolveProviderConfig).toHaveBeenCalledWith('same-model');
    expect(harness.config.update).not.toHaveBeenCalled();
    expect(harness.telemetryCalls).toEqual([]);
  });

  it('beginCompaction forwards source=manual; cancelCompaction tracks only when compacting', () => {
    const harness = makeHost();
    const methods = harness.controller.rpcMethods;

    methods.beginCompaction({ instruction: 'shrink' } as never);
    expect(harness.fullCompaction.begin).toHaveBeenCalledWith({
      source: 'manual',
      instruction: 'shrink',
    });

    methods.cancelCompaction(undefined as never);
    expect(harness.fullCompaction.cancel).toHaveBeenCalledTimes(1);
    expect(harness.telemetryCalls).toEqual([]);

    harness.fullCompaction.isCompacting = true;
    methods.cancelCompaction(undefined as never);
    expect(harness.telemetryCalls).toEqual([
      { event: 'cancel', properties: { from: 'compacting' } },
    ]);
  });

  it('activateSkill throws KimiError when skills are unavailable, otherwise activates', () => {
    const nullSkills = makeHost({ skills: 'null' });
    expect(() =>
      nullSkills.controller.rpcMethods.activateSkill({ name: 'missing' } as never),
    ).toThrowError(/Skill "missing" was not found/);

    const present = makeHost();
    present.controller.rpcMethods.activateSkill({ name: 'present' } as never);
    expect(present.skills?.activate).toHaveBeenCalledWith({ name: 'present' });
  });
});
