import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SPINE_TRIM_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService, SPINE_TOOL_TRIM } from '#/agent/spine/spine';
import { normalizeTrimOp } from '#/agent/spine/spineTrimDerive';
import { IFlagService } from '#/app/flag/flag';
import { toTrimResult } from './controlResult';
import {
  SPINE_TRIM_ANCHOR_DESCRIPTION,
  SPINE_TRIM_DESCRIPTION,
  SPINE_TRIM_FOLLOWING_DESCRIPTION,
  SPINE_TRIM_HEAD_DESCRIPTION,
  SPINE_TRIM_ID_DESCRIPTION,
  SPINE_TRIM_OP_DESCRIPTION,
  SPINE_TRIM_PRECEDING_DESCRIPTION,
  SPINE_TRIM_TAIL_DESCRIPTION,
} from './descriptions';

const SpineTrimInputSchema = z.object({
  TRIM_ID: z.string().min(1).describe(SPINE_TRIM_ID_DESCRIPTION),
  op: z.enum(['snip', 'slice']).describe(SPINE_TRIM_OP_DESCRIPTION),
  head: z.number().int().positive().optional().describe(SPINE_TRIM_HEAD_DESCRIPTION),
  tail: z.number().int().positive().optional().describe(SPINE_TRIM_TAIL_DESCRIPTION),
  anchor: z.string().min(1).optional().describe(SPINE_TRIM_ANCHOR_DESCRIPTION),
  preceding: z.number().int().nonnegative().optional().describe(SPINE_TRIM_PRECEDING_DESCRIPTION),
  following: z.number().int().nonnegative().optional().describe(SPINE_TRIM_FOLLOWING_DESCRIPTION),
});

export type SpineTrimInput = z.infer<typeof SpineTrimInputSchema>;

const REJECT_SLICE_SHAPE =
  'op="slice" requires exactly one of head, tail, or anchor; correct the arguments and retry.';

export interface ISpineTrimTool extends AgentTool<SpineTrimInput> {
  readonly _serviceBrand: undefined;
}
export const ISpineTrimTool = createDecorator<ISpineTrimTool>('spineTrimTool');

export class SpineTrimTool implements ISpineTrimTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SPINE_TOOL_TRIM;
  readonly description = SPINE_TRIM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SpineTrimInputSchema);

  constructor(@IAgentSpineService private readonly spine: IAgentSpineService) {}

  resolveExecution(input: SpineTrimInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Trim a tagged tool result',
      execute: async () => {
        const op = normalizeTrimOp(input.op, input);
        if (op === undefined) return { isError: true, output: REJECT_SLICE_SHAPE };
        return toTrimResult(this.spine.acceptTrim(input.TRIM_ID, op));
      },
    };
  }
}

registerAgentToolService(ISpineTrimTool, SpineTrimTool, {
  name: SPINE_TOOL_TRIM,
  domain: 'spine',
  when: (accessor) =>
    accessor.get(IFlagService).enabled(SPINE_TRIM_FLAG_ID) &&
    accessor.get(IAgentScopeContext).agentId === 'main',
});
