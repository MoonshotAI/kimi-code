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
import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import {
  ARTEX_FACT_CONFIDENCES,
  normalizeArtexFactSource,
} from '#/features/artex/protocol/index';

import {
  ARTEX_INACTIVE_RESULT,
  artexErr,
  artexJson,
  openActiveGraph,
} from '../toolSupport';
import DESCRIPTION from './record_fact.md?raw';

const FactItemSchema = z.object({
  summary: z.string().optional(),
  detail: z.string().optional(),
  evidence: z.string().optional(),
  confidence: z.enum(ARTEX_FACT_CONFIDENCES).optional(),
  source: z.string().optional(),
  intent_id: z.number().int().optional(),
  asset_ids: z.array(z.number().int()).optional(),
});

export const RecordFactInputSchema = z.object({
  facts: z.array(FactItemSchema).optional(),
  summary: z.string().optional(),
  detail: z.string().optional(),
  evidence: z.string().optional(),
  confidence: z.enum(ARTEX_FACT_CONFIDENCES).optional(),
  source: z.string().optional(),
  intent_id: z.number().int().optional(),
  asset_ids: z.array(z.number().int()).optional(),
});

export type RecordFactInput = z.infer<typeof RecordFactInputSchema>;
type FactItem = z.infer<typeof FactItemSchema>;

const PARAMETERS = toInputJsonSchema(RecordFactInputSchema);

export const IArtexRecordFactTool: ServiceIdentifier<AgentTool<RecordFactInput>> =
  createDecorator<AgentTool<RecordFactInput>>('artexRecordFactTool');

async function recordOneFact(
  store: IArtexGraphStore,
  worker: string,
  item: FactItem,
  defaultIntent: number | undefined,
): Promise<number> {
  const summary = (item.summary ?? '').trim();
  if (summary.length === 0) throw new Error('summary must not be empty');
  const normalized = normalizeArtexFactSource(item.source);
  if (normalized.error !== undefined) throw new Error(normalized.error);
  const payload: Record<string, unknown> = { summary, source: normalized.source };
  if (item.detail !== undefined && item.detail.trim().length > 0) {
    payload['detail'] = item.detail.trim();
  }
  if (item.evidence !== undefined && item.evidence.trim().length > 0) {
    payload['evidence'] = item.evidence.trim();
  }
  if (item.confidence !== undefined) payload['confidence'] = item.confidence;
  const intent = item.intent_id ?? defaultIntent;
  if (intent !== undefined && intent > 0) {
    const node = await store.getNode(intent);
    if (node === undefined || node.kind !== 'intent') {
      throw new Error('intent_id must be an intent of this task');
    }
  }
  const id = await store.addNode({
    kind: 'fact',
    payload,
    priority: 5,
    state: 'confirmed',
    origin: worker,
    anchors: item.asset_ids,
  });
  if (intent !== undefined && intent > 0) await store.link(intent, 'yields', id);
  return id;
}

export class ArtexRecordFactTool implements AgentTool<RecordFactInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'record_fact' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  private readonly worker: string;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
    @IAgentScopeContext scope: IAgentScopeContext,
    @IArtexOrchestrator private readonly orchestrator?: IArtexOrchestrator,
  ) {
    this.worker = scope.agentId;
  }

  resolveExecution(args: RecordFactInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Recording an ARTEX exploration fact',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: RecordFactInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const batch = (args.facts?.length ?? 0) > 0;
    const items: FactItem[] = batch
      ? (args.facts ?? [])
      : [
          {
            summary: args.summary,
            detail: args.detail,
            evidence: args.evidence,
            confidence: args.confidence,
            source: args.source,
            intent_id: args.intent_id,
            asset_ids: args.asset_ids,
          },
        ];
    const defaultIntent = args.intent_id;
    const ids: number[] = Array.from({ length: items.length }, () => 0);
    const errors: Record<string, string> = {};
    for (let index = 0; index < items.length; index += 1) {
      try {
        ids[index] = await recordOneFact(handle.store, this.worker, items[index]!, defaultIntent);
      } catch (error) {
        errors[String(index)] = error instanceof Error ? error.message : String(error);
      }
    }
    if (!batch) {
      const message = errors['0'];
      if (message !== undefined) return artexErr(message);
      this.orchestrator?.notifyGraphChanged(handle.explorationId, 'record_fact');
      return { output: `fact recorded: ${String(ids[0])}` };
    }
    if (ids.some((id) => id > 0)) {
      this.orchestrator?.notifyGraphChanged(handle.explorationId, 'record_fact');
    }
    const out: Record<string, unknown> = { ids };
    if (Object.keys(errors).length > 0) out['errors'] = errors;
    return { output: artexJson(out) };
  }
}
