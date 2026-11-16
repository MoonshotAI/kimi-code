import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';
import { ARTEX_VERIFICATION_MIN_CONFIDENCE } from '#/features/artex/tools/report_finding/report_finding';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './update_finding_report.md?raw';

export const UpdateFindingReportInputSchema = z.object({
  finding_id: z.number().int(),
  report: z.string(),
  evidence_version: z.number().int().optional(),
  poe_level: z.number().int().min(0).max(4).optional(),
  evidence_quotes: z.array(z.string()).optional(),
});

export type UpdateFindingReportInput = z.infer<typeof UpdateFindingReportInputSchema>;

const PARAMETERS = toInputJsonSchema(UpdateFindingReportInputSchema);

export const IArtexUpdateFindingReportTool: ServiceIdentifier<AgentTool<UpdateFindingReportInput>> =
  createDecorator<AgentTool<UpdateFindingReportInput>>('artexUpdateFindingReportTool');

export class ArtexUpdateFindingReportTool implements AgentTool<UpdateFindingReportInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'update_finding_report' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder,
  ) {}

  resolveExecution(args: UpdateFindingReportInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Updating ARTEX finding report ${String(args.finding_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: UpdateFindingReportInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const node = await store.getNode(args.finding_id);
    if (node === undefined || node.kind !== 'finding') {
      return artexErr(`finding_id ${String(args.finding_id)} is not a finding of this exploration`);
    }
    const trafficStore = this.recorder.store();
    const bindings = await trafficStore.findingBindings(args.finding_id);
    const version = bindings.length;
    if (args.evidence_version !== undefined && args.evidence_version !== version) {
      return artexErr(
        `evidence_version mismatch: expected ${String(version)}, got ${String(args.evidence_version)}`,
      );
    }
    const verification = await this.assessVerification(
      args.finding_id,
      args.poe_level,
      args.evidence_quotes ?? [],
    );
    await store.mergeNodePayload(args.finding_id, {
      report: args.report,
      report_status: 'updated',
      verification_status: verification.status,
      verification_note: verification.note,
      evidence_version: version,
    });
    trafficStore.scheduleArtifactCollection();
    return {
      output: artexJson({
        finding_id: args.finding_id,
        chars: args.report.length,
        evidence_version: version,
        verification_status: verification.status,
        verification_note: verification.note,
      }),
    };
  }

  private async assessVerification(
    findingNodeId: number,
    poeLevel: number | undefined,
    quotes: readonly string[],
  ): Promise<{ readonly status: string; readonly note: string }> {
    const proofs = (await this.recorder.store().findingBindings(findingNodeId)).filter(
      (binding) => binding.role === 'proof' || binding.role === 'verification',
    );
    if (proofs.length === 0) return { status: 'unverified', note: 'no proof traffic bound' };
    const level = poeLevel ?? 0;
    if (level < ARTEX_VERIFICATION_MIN_CONFIDENCE) {
      return { status: 'unverified', note: `poe_level ${String(level)} below ${String(ARTEX_VERIFICATION_MIN_CONFIDENCE)}` };
    }
    const store = this.recorder.store();
    for (const quote of quotes) {
      let matched = false;
      for (const proof of proofs) {
        const result = await store.verbatimInSnapshot(proof.snapshot, quote);
        if (result.found) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        return { status: 'unverified', note: `quote not found verbatim in bound response body` };
      }
    }
    return { status: 'verified', note: '' };
  }
}