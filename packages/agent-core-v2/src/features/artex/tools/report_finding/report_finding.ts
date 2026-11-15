import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ARTEX_FINDING_SEVERITIES } from '#/features/artex/protocol/index';

import {
  ARTEX_INACTIVE_RESULT,
  artexErr,
  artexJson,
  openActiveGraph,
} from '../toolSupport';
import DESCRIPTION from './report_finding.md?raw';

export const ReportFindingInputSchema = z.object({
  vulnclass: z.string(),
  name: z.string(),
  severity: z.enum(ARTEX_FINDING_SEVERITIES).optional(),
  summary: z.string(),
  intent_id: z.number().int().optional(),
  asset_ids: z.array(z.number().int()).optional(),
  evidence: z.string().optional(),
  counterevidence: z.string().optional(),
  confidence_rationale: z.string().optional(),
});

export type ReportFindingInput = z.infer<typeof ReportFindingInputSchema>;

const PARAMETERS = toInputJsonSchema(ReportFindingInputSchema);

export const IArtexReportFindingTool: ServiceIdentifier<AgentTool<ReportFindingInput>> =
  createDecorator<AgentTool<ReportFindingInput>>('artexReportFindingTool');

function sameAssets(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].toSorted((x, y) => x - y);
  const b = [...right].toSorted((x, y) => x - y);
  return a.every((value, index) => value === b[index]);
}

export class ArtexReportFindingTool implements AgentTool<ReportFindingInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'report_finding' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  private readonly worker: string;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IAgentScopeContext scope: IAgentScopeContext,
  ) {
    this.worker = scope.agentId;
  }

  resolveExecution(args: ReportFindingInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Reporting ARTEX finding: ${args.name}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ReportFindingInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const assetIds = args.asset_ids ?? [];

    const existing = await store.listByKind('finding');
    const duplicate = existing.find((node) => {
      if (node.state !== 'confirmed') return false;
      const payload = node.payload as { vulnclass?: unknown; name?: unknown; asset_ids?: unknown };
      const existingAssets = Array.isArray(payload.asset_ids)
        ? (payload.asset_ids as number[])
        : [];
      return (
        payload.vulnclass === args.vulnclass &&
        payload.name === args.name &&
        sameAssets(existingAssets, assetIds)
      );
    });
    if (duplicate !== undefined) {
      return artexErr(
        `a confirmed finding for "${args.name}" (${args.vulnclass}) on the same assets already exists as node ${String(duplicate.id)}; not reporting a duplicate`,
      );
    }

    const intent = args.intent_id;
    if (intent !== undefined && intent > 0) {
      const node = await store.getNode(intent);
      if (node === undefined || node.kind !== 'intent') {
        return artexErr('intent_id must be an intent of this task');
      }
    }

    const payload: Record<string, unknown> = {
      vulnclass: args.vulnclass,
      name: args.name,
      severity: args.severity ?? '',
      summary: args.summary,
      worker: this.worker,
      evidence_status: 'not_bound',
    };
    if (assetIds.length > 0) payload['asset_ids'] = assetIds;
    if (args.evidence !== undefined) payload['evidence'] = args.evidence;
    if (args.counterevidence !== undefined) payload['counterevidence'] = args.counterevidence;
    if (args.confidence_rationale !== undefined) {
      payload['confidence_rationale'] = args.confidence_rationale;
    }

    const id = await store.addNode({
      kind: 'finding',
      payload,
      priority: 5,
      state: 'confirmed',
      origin: this.worker,
      anchors: assetIds,
    });
    if (intent !== undefined && intent > 0) await store.link(intent, 'yields', id);

    return {
      output: artexJson({
        finding_node_id: id,
        evidence_status: 'not_bound',
        evidence_note:
          'Finding saved. Automatic traffic binding is not available in this build; link traffic evidence later via the evidence pipeline.',
      }),
    };
  }
}
