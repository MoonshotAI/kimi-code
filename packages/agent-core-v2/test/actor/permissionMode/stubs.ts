import { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { toContractMode } from '#/actor/permissionMode/internal/modeMapping';
import type { PermissionModeRuntime } from '#/actor/permissionMode/permissionModeAgentRuntime';
import type { WirePermissionMode } from '#/actor/permissionMode/permissionModeOps';
import type { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';

export function stubPermissionModeRuntime(
  mode: () => WirePermissionMode,
  input: {
    readonly configured?: () => boolean;
    readonly changeMode?: PermissionModeRuntime['changeMode'];
  } = {},
): PermissionModeRuntime {
  return {
    mode: () => toContractMode(mode()),
    configured: input.configured ?? (() => true),
    changeMode: input.changeMode ?? (() => Promise.resolve()),
    onDidChange: Event.None,
  } as unknown as PermissionModeRuntime;
}

export function stubSessionPermissionModeService(input: {
  readonly mode: () => WirePermissionMode;
  readonly configured?: () => boolean;
  readonly setMode?: (mode: WirePermissionMode) => void;
  readonly setModeAndBroadcast?: (mode: WirePermissionMode) => void;
}): ISessionPermissionModeService {
  return {
    _serviceBrand: undefined,
    mode: input.mode,
    configured: input.configured ?? (() => true),
    setMode: (_agent: AgentContext, mode: WirePermissionMode) => input.setMode?.(mode),
    setModeAndBroadcast: (_agent: AgentContext, mode: WirePermissionMode) => {
      input.setModeAndBroadcast?.(mode);
    },
  } as unknown as ISessionPermissionModeService;
}
