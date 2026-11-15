import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ARTEX_TRAFFIC_ROLES, type ArtexTrafficRef } from '#/features/artex/store/artexTrafficStore';
import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import {
  ARTEX_INACTIVE_RESULT,
  artexErr,
  artexJson,
  artexRecordingInactive,
  openActiveGraph,
} from '../toolSupport';
import DESCRIPTION from './bind_finding_traffic.md?raw';

export const BindFindingTrafficInputSchema = z.object({
  finding_node_id: z.number().int(),
  traffic_refs: z
    .array(
      z.object({
        traffic_id: z.string(),
        role: z.enum(ARTEX_TRAFFIC_ROLES).optional(),
        note: z.string().optional(),
      }),
    )
    .min(1),
});

export type BindFindingTrafficInput = z.infer<typeof BindFindingTrafficInputSchema>;

const PARAMETERS = toInputJsonSchema(BindFindingTrafficInputSchema);

export const IArtexBindFindingTrafficTool: ServiceIdentifier<AgentTool<BindFindingTrafficInput>> =
  createDecorator<AgentTool<BindFindingTrafficInput>>('artexBindFindingTrafficTool');

export class ArtexBindFindingTrafficTool implements AgentTool<BindFindingTrafficInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'bind_finding_traffic' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder,
  ) {}

  resolveExecution(args: BindFindingTrafficInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Binding traffic evidence to ARTEX finding ${String(args.finding_node_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: BindFindingTrafficInput): Promise<ExecutableToolResult> {
    const inactive = await artexRecordingInactive(this.recorder);
    if (inactive !== undefined) return inactive;
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const node = await store.getNode(args.finding_node_id);
    if (node === undefined || node.kind !== 'finding') {
      return artexErr(`finding_node_id ${String(args.finding_node_id)} is not a finding of this exploration`);
    }
    const refs: ArtexTrafficRef[] = args.traffic_refs.map((ref) => ({
      trafficId: ref.traffic_id,
      role: ref.role,
      note: ref.note,
    }));
    let created: number;
    try {
      created = await this.recorder.store().bindToFinding(args.finding_node_id, refs);
    } catch (error) {
      return artexErr(error instanceof Error ? error.message : String(error));
    }
    const bindings = await this.recorder.store().findingBindings(args.finding_node_id);
    await store.mergeNodePayload(args.finding_node_id, {
      evidence_status: 'bound',
      report_status: 'pending_update',
    });
    return {
      output: artexJson({
        finding_node_id: args.finding_node_id,
        bound: created,
        total_bindings: bindings.length,
        bindings: bindings.map((binding) => ({
          role: binding.role,
          position: binding.position,
          source_traffic_id: binding.snapshot.sourceTrafficId,
          note: binding.note,
        })),
      }),
    };
  }
}
