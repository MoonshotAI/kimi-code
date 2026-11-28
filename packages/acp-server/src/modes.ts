import type { SessionMode } from '@agentclientprotocol/sdk';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2';

export const ACP_MODES = [
  {
    id: 'default',
    name: 'Default',
    description: 'Manual approvals; tools execute normally.',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only planning; no tool execution.',
  },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Run unattended, including sensitive operations, while honoring explicit deny rules.',
  },
  {
    id: 'yolo',
    name: 'YOLO',
    description: 'Approve routine operations automatically. Sensitive actions can still require confirmation.',
  },
] as const satisfies readonly SessionMode[];

export const DEFAULT_MODE_ID = 'default' as const;

export type AcpModeId = 'default' | 'plan' | 'auto' | 'yolo';

export function isAcpModeId(value: unknown): value is AcpModeId {
  return value === 'default' || value === 'plan' || value === 'auto' || value === 'yolo';
}

export interface AcpModeToggles {
  readonly plan: boolean;
  readonly permission: PermissionMode;
}

export function acpModeToToggles(id: AcpModeId): AcpModeToggles {
  switch (id) {
    case 'default':
      return { plan: false, permission: 'manual' };
    case 'plan':
      return { plan: true, permission: 'manual' };
    case 'auto':
      return { plan: false, permission: 'auto' };
    case 'yolo':
      return { plan: false, permission: 'yolo' };
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unhandled AcpModeId: ${String(_exhaustive)}`);
    }
  }
}
