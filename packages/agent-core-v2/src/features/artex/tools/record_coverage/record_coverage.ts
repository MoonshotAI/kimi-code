import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import {
  ARTEX_COVERAGE_OUTCOMES,
  type ArtexCoverageEntry,
} from '#/features/artex/protocol/index';
import { buildCoverageLedger, coverageGapLabel } from '#/features/artex/logic/coverageLedger';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

import { ARTEX_INACTIVE_RESULT, artexErr, openActiveWork } from '../toolSupport';
import DESCRIPTION from './record_coverage.md?raw';

export const RecordCoverageInputSchema = z.object({
  surface: z.string(),
  risk_area: z.string(),
  outcome: z.enum(ARTEX_COVERAGE_OUTCOMES),
  evidence: z.string().optional(),
  reason: z.string().optional(),
  intent_id: z.number().int().min(1).optional(),
});

export type RecordCoverageInput = z.infer<typeof RecordCoverageInputSchema>;

const PARAMETERS = toInputJsonSchema(RecordCoverageInputSchema);

export const IArtexRecordCoverageTool: ServiceIdentifier<AgentTool<RecordCoverageInput>> =
  createDecorator<AgentTool<RecordCoverageInput>>('artexRecordCoverageTool');

export class ArtexRecordCoverageTool implements AgentTool<RecordCoverageInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'record_coverage' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  private readonly worker: string;
  private readonly defaultIntentId?: number;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexWorkStoreProvider private readonly provider: IArtexWorkStoreProvider,
    @IAgentScopeContext scope: IAgentScopeContext,
  ) {
    this.worker = scope.agentId;
    const rawIntent = Number(scope.meta?.labels?.['artexIntentId']);
    this.defaultIntentId =
      Number.isInteger(rawIntent) && rawIntent > 0 ? rawIntent : undefined;
  }

  resolveExecution(args: RecordCoverageInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Recording ARTEX coverage',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: RecordCoverageInput): Promise<ExecutableToolResult> {
    const handle = await openActiveWork(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    if (args.surface.trim() === '') return artexErr('surface must not be empty');
    if (args.risk_area.trim() === '') return artexErr('risk_area must not be empty');
    const entry: ArtexCoverageEntry = {
      surface: args.surface,
      riskArea: args.risk_area,
      outcome: args.outcome,
      evidence: args.evidence ?? '',
      reason: args.reason ?? '',
      worker: this.worker,
      intentId: args.intent_id ?? this.defaultIntentId,
    };
    try {
      await handle.store.recordCoverage(handle.taskId, entry);
    } catch (error) {
      return artexErr(error instanceof Error ? error.message : String(error));
    }
    const ledger = buildCoverageLedger([entry], [], {
      complete: false,
      state: 'in_progress',
      caveat: '',
    });
    const gap = ledger.gaps[0];
    if (gap !== undefined) {
      return { output: `recorded, but counted as a gap: ${coverageGapLabel(gap)}` };
    }
    return { output: 'recorded' };
  }
}
