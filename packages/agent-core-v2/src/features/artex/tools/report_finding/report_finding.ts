import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexOrchestrator } from '#/features/artex/engine/artexOrchestrator';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ARTEX_FINDING_SEVERITIES } from '#/features/artex/protocol/index';
import { ARTEX_TRAFFIC_ROLES, type ArtexTrafficRef } from '#/features/artex/store/artexTrafficStore';
import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import {
  ARTEX_INACTIVE_RESULT,
  artexErr,
  artexJson,
  openActiveGraph,
} from '../toolSupport';
import DESCRIPTION from './report_finding.md?raw';

export const ARTEX_VERIFICATION_MIN_CONFIDENCE = 3;
const MIN_QUOTE_LENGTH = 8;

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
  confidence_level: z.number().int().min(1).max(4).optional(),
  traffic_refs: z
    .array(
      z.object({
        traffic_id: z.string(),
        role: z.enum(ARTEX_TRAFFIC_ROLES).optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  evidence_quotes: z.array(z.string()).optional(),
});

export type ReportFindingInput = z.infer<typeof ReportFindingInputSchema>;

const PARAMETERS = toInputJsonSchema(ReportFindingInputSchema);

export const IArtexReportFindingTool: ServiceIdentifier<AgentTool<ReportFindingInput>> =
  createDecorator<AgentTool<ReportFindingInput>>('artexReportFindingTool');

interface VerificationOutcome {
  readonly status: 'verified' | 'unverified';
  readonly note: string;
}

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
    @IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
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

    const refs = (args.traffic_refs ?? []).map(
      (ref): ArtexTrafficRef => ({ trafficId: ref.traffic_id, role: ref.role, note: ref.note }),
    );
    if (refs.length > 0) {
      const unavailable = await this.rejectUnbindableRefs(refs);
      if (unavailable !== undefined) return unavailable;
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
    if (args.confidence_level !== undefined) payload['confidence_level'] = args.confidence_level;

    const id = await store.addNode({
      kind: 'finding',
      payload,
      priority: 5,
      state: 'confirmed',
      origin: this.worker,
      anchors: assetIds,
    });
    if (intent !== undefined && intent > 0) await store.link(intent, 'yields', id);

    let bound = 0;
    if (refs.length > 0) bound = await this.recorder.store().bindToFinding(id, refs);
    const evidenceStatus = bound > 0 ? 'bound' : 'not_bound';
    const verification = await this.assessVerification(id, args.confidence_level, args.evidence_quotes ?? []);

    await store.mergeNodePayload(id, {
      evidence_status: evidenceStatus,
      verification_status: verification.status,
      verification_note: verification.note,
      evidence_quotes: args.evidence_quotes ?? [],
    });

    this.orchestrator?.notifyGraphChanged(handle.explorationId, 'report_finding');

    return {
      output: artexJson({
        finding_node_id: id,
        evidence_status: evidenceStatus,
        bound_traffic: bound,
        verification_status: verification.status,
        verification_note: verification.note,
      }),
    };
  }

  private async rejectUnbindableRefs(
    refs: readonly ArtexTrafficRef[],
  ): Promise<ExecutableToolResult | undefined> {
    const state = await this.recorder.ensureStarted();
    switch (state.status) {
      case 'recording':
        break;
      case 'unavailable':
        return artexErr(
          `cannot bind traffic_refs because recording is unavailable: ${state.reason ?? 'unknown reason'}. Report without traffic_refs, or re-run once recording works; the finding is not saved so nothing is silently bound.`,
        );
      case 'off':
        return artexErr(
          'cannot bind traffic_refs because traffic recording is not active in this session. Report without traffic_refs.',
        );
      default: {
        const exhaustive: never = state.status;
        return exhaustive;
      }
    }
    const store = this.recorder.store();
    for (const ref of refs) {
      const record = await store.get(ref.trafficId);
      if (record === undefined) {
        return artexErr(`traffic ${ref.trafficId} does not exist; the finding is not saved so nothing is bound`);
      }
    }
    return undefined;
  }

  /**
   * A finding counts as verified only when the agent declared confidence >= 3, a
   * proof/verification body is bound, and every supplied quote appears
   * byte-for-byte in one of those bodies. Anything else stays unverified with a
   * reason — the level is never silently promoted.
   */
  private async assessVerification(
    findingNodeId: number,
    confidenceLevel: number | undefined,
    quotes: readonly string[],
  ): Promise<VerificationOutcome> {
    const bindings = await this.recorder.store().findingBindings(findingNodeId);
    const proofs = bindings.filter(
      (binding) => binding.role === 'proof' || binding.role === 'verification',
    );
    if (proofs.length === 0) return { status: 'unverified', note: 'no proof traffic bound' };
    if (confidenceLevel === undefined || confidenceLevel < ARTEX_VERIFICATION_MIN_CONFIDENCE) {
      return {
        status: 'unverified',
        note: `confidence_level ${String(confidenceLevel ?? 0)} below ${String(ARTEX_VERIFICATION_MIN_CONFIDENCE)}`,
      };
    }
    const checkable = quotes.filter((quote) => quote.length >= MIN_QUOTE_LENGTH);
    if (checkable.length === 0) {
      return { status: 'unverified', note: quotes.length === 0 ? 'no evidence quotes provided' : 'evidence quote too short' };
    }
    const store = this.recorder.store();
    for (const quote of checkable) {
      let matched = false;
      for (const proof of proofs) {
        const result = await store.verbatimInSnapshot(proof.snapshot, quote);
        if (result.found) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        return { status: 'unverified', note: `quote not found verbatim in bound evidence: ${shortQuote(quote)}` };
      }
    }
    return { status: 'verified', note: '' };
  }
}

function shortQuote(quote: string): string {
  return quote.length <= 60 ? quote : `${quote.slice(0, 60)}…`;
}
