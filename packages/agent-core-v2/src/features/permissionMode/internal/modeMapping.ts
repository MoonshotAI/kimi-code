import type { PermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import type { WirePermissionMode } from '#/features/permissionMode/permissionModeOps';

export function toContractMode(mode: WirePermissionMode): PermissionMode {
  switch (mode) {
    case 'manual':
      return 'default';
    case 'yolo':
      return 'dangerous';
    case 'auto':
      return 'auto';
  }
}

export function toWireMode(mode: PermissionMode): WirePermissionMode {
  switch (mode) {
    case 'default':
      return 'manual';
    case 'dangerous':
      return 'yolo';
    case 'auto':
      return 'auto';
    case 'plan':
      throw new Error(`Permission mode 'plan' has no wire representation yet`);
  }
}
