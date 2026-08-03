import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PermissionMode } from '../../../src/agent/permission';
import { EnterPlanModeTool } from '../../../src/tools/builtin/planning/enter-plan-mode';
import { executeTool } from '../fixtures/execute-tool';

function makeAgent(mode: PermissionMode): {
  readonly agent: Agent;
  readonly requestApproval: ReturnType<typeof vi.fn>;
  readonly telemetryTrack: ReturnType<typeof vi.fn>;
} {
  let active = false;
  const requestApproval = vi.fn(async () => ({ decision: 'approved' }));
  const telemetryTrack = vi.fn();
  const agent = {
    planMode: {
      get isActive() {
        return active;
      },
      get planFilePath() {
        return '/tmp/kimi-plan.md';
      },
      enter: vi.fn(async () => {
        active = true;
      }),
    },
    permission: { mode },
    rpc: { requestApproval },
    telemetry: { track: telemetryTrack },
  } as unknown as Agent;
  return { agent, requestApproval, telemetryTrack };
}

describe('EnterPlanMode telemetry', () => {
  it.each(['manual', 'auto', 'yolo'] satisfies PermissionMode[])(
    'tracks direct entry as auto_approved in %s mode',
    async (mode) => {
      const { agent, requestApproval, telemetryTrack } = makeAgent(mode);

      const result = await executeTool(new EnterPlanModeTool(agent), {
        turnId: '0',
        toolCallId: `call_${mode}`,
        args: {},
        signal: new AbortController().signal,
      });

      expect(result.isError).toBeFalsy();
      expect(requestApproval).not.toHaveBeenCalled();
      expect(telemetryTrack).toHaveBeenCalledWith('plan_enter_resolved', {
        outcome: 'auto_approved',
      });
    },
  );
});
