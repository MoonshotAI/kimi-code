import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, clipText, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './get_finding_traffic.md?raw';

export const GetFindingTrafficInputSchema = z.object({
  finding_id: z.number().int(),
  binding_id: z.number().int().optional(),
  side: z.enum(['request', 'response']).optional(),
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(1).max(65536).optional(),
});

export type GetFindingTrafficInput = z.infer<typeof GetFindingTrafficInputSchema>;

const PARAMETERS = toInputJsonSchema(GetFindingTrafficInputSchema);

export const IArtexGetFindingTrafficTool: ServiceIdentifier<AgentTool<GetFindingTrafficInput>> =
  createDecorator<AgentTool<GetFindingTrafficInput>>('artexGetFindingTrafficTool');

export class ArtexGetFindingTrafficTool implements AgentTool<GetFindingTrafficInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'get_finding_traffic' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder,
  ) {}

  resolveExecution(args: GetFindingTrafficInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Reading ARTEX traffic evidence for finding ${String(args.finding_id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: GetFindingTrafficInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const node = await handle.store.getNode(args.finding_id);
    if (node === undefined || node.kind !== 'finding') {
      return artexErr(`finding_id ${String(args.finding_id)} is not a finding of this exploration`);
    }
    const store = this.recorder.store();
    const bindings = await store.findingBindings(args.finding_id);
    const evidenceVersion = bindings.length;
    if (args.binding_id === undefined) {
      return {
        output: artexJson({
          finding_id: args.finding_id,
          evidence_version: evidenceVersion,
          bindings: bindings.map((binding) => ({
            binding_id: binding.id,
            role: binding.role,
            position: binding.position,
            source_traffic_id: binding.snapshot.sourceTrafficId,
            note: binding.note,
          })),
        }),
      };
    }
    const binding = bindings.find((entry) => entry.id === args.binding_id);
    if (binding === undefined) {
      return artexErr(`binding_id ${String(args.binding_id)} does not exist on this finding`);
    }
    const side = args.side ?? 'response';
    const offset = args.offset ?? 0;
    const length = args.length ?? 4096;
    const hash = side === 'request' ? binding.snapshot.reqHash : binding.snapshot.respHash;
    const preview = await store.blobRange(hash, offset, length);
    if (preview === undefined) {
      return artexErr(`evidence blob ${hash} is missing`);
    }
    const head = side === 'request' ? binding.snapshot.reqHead : binding.snapshot.respHead;
    return {
      output: artexJson({
        binding_id: binding.id,
        side,
        head,
        body: clipText(preview.data.toString('utf8'), length),
        total: preview.total,
        evidence_version: evidenceVersion,
      }),
    };
  }
}