/**
 * ACP session-mode taxonomy.
 *
 * The 4 modes (`default`, `plan`, `auto`, `yolo`) are the locked decision.
 * Every `session/new` and `session/load` response advertises {@link ACP_MODES}
 * as the mode picker plus {@link DEFAULT_MODE_ID} as `currentModeId`, so ACP
 * clients render the dropdown from a single canonical source.
 *
 * `session/set_mode` and the `mode` arm of `session/set_config_option` consume
 * the same source of truth: {@link isAcpModeId} narrows the wire string, and
 * {@link acpModeToToggles} resolves the two underlying engine toggles (plan
 * mode + permission mode) each ACP mode maps to.
 */

import type { SessionMode } from '@agentclientprotocol/sdk';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2';

/**
 * Canonical 4-mode taxonomy. Order matters: the array is rendered as-is by the
 * client, so `default` must appear first and `yolo` last.
 */
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
    description: 'Auto-approve safe operations.',
  },
  {
    id: 'yolo',
    name: 'YOLO',
    description: 'Auto-approve everything.',
  },
] as const satisfies readonly SessionMode[];

/** Initial `currentModeId` for every freshly created ACP session. */
export const DEFAULT_MODE_ID = 'default' as const;

/** The four wire-level mode ids understood by this host. */
export type AcpModeId = 'default' | 'plan' | 'auto' | 'yolo';

/** Narrow an unknown wire string to {@link AcpModeId}. */
export function isAcpModeId(value: unknown): value is AcpModeId {
  return value === 'default' || value === 'plan' || value === 'auto' || value === 'yolo';
}

/**
 * The two underlying engine toggles each ACP mode maps to. `plan` drives
 * `IAgentPlanService` (enter/exit plan mode) and `permission` drives
 * `IAgentPermissionModeService.setMode`.
 */
export interface AcpModeToggles {
  readonly plan: boolean;
  readonly permission: PermissionMode;
}

/**
 * Resolve an {@link AcpModeId} to its underlying engine toggles. The `switch`
 * deliberately enumerates every arm of {@link AcpModeId} so the compiler
 * enforces exhaustiveness — adding a 5th mode without extending this table is
 * a typecheck error (the `never` fallthrough), not a silent runtime no-op.
 */
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
