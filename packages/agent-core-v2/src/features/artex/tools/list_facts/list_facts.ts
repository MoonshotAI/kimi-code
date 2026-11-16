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

import { ARTEX_INACTIVE_RESULT, openActiveGraph } from '../toolSupport';
import { artexEnvelopedJson } from '../envelopeOutput';
import DESCRIPTION from './list_facts.md?raw';

const DEFAULT_FACTS_PAGE_SIZE = 20;
const MAX_FACTS_PAGE_SIZE = 100;
const FACT_SUMMARY_MAX = 160;

export const ListFactsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  before: z.number().int().min(0).optional(),
  q: z.string().optional(),
});

export type ListFactsInput = z.infer<typeof ListFactsInputSchema>;

const PARAMETERS = toInputJsonSchema(ListFactsInputSchema);

export const IArtexListFactsTool: ServiceIdentifier<AgentTool<ListFactsInput>> =
  createDecorator<AgentTool<ListFactsInput>>('artexListFactsTool');

function compactSummary(raw: unknown): { readonly summary: string; readonly truncated: boolean } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const chars = Array.from(text);
  if (chars.length <= FACT_SUMMARY_MAX) {
    return { summary: text, truncated: false };
  }
  return {
    summary: `${chars.slice(0, FACT_SUMMARY_MAX).join('')}…`,
    truncated: true,
  };
}

export class ArtexListFactsTool implements AgentTool<ListFactsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_facts' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: ListFactsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing ARTEX facts',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ListFactsInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const rawLimit = args.limit ?? DEFAULT_FACTS_PAGE_SIZE;
    const limit = Math.min(Math.max(1, rawLimit), MAX_FACTS_PAGE_SIZE);
    const q = (args.q ?? '').trim().toLowerCase();
    const before = args.before ?? 0;

    const allFacts = (await handle.store.listByKind('fact')).toSorted((a, b) => b.id - a.id);
    const matched =
      q === ''
        ? allFacts
        : allFacts.filter((node) => {
            const payload = node.payload as Record<string, unknown>;
            const summaryText =
              typeof payload['summary'] === 'string' ? payload['summary'] : '';
            const rawText = typeof payload['text'] === 'string' ? payload['text'] : '';
            return (
              summaryText.toLowerCase().includes(q) || rawText.toLowerCase().includes(q)
            );
          });
    const total = matched.length;
    const afterBefore = before > 0 ? matched.filter((node) => node.id < before) : matched;
    const hasMore = afterBefore.length > limit;
    const page = afterBefore.slice(0, limit);

    const facts = page.map((node) => {
      const payload = node.payload as Record<string, unknown>;
      const { summary, truncated } = compactSummary(payload['summary'] ?? payload['text']);
      return {
        id: node.id,
        node_id: node.id,
        state: node.state,
        summary,
        summary_truncated: truncated ? true : undefined,
        origin: node.origin,
        source: payload['source'],
        confidence: payload['confidence'],
      };
    });

    const out: Record<string, unknown> = {
      facts,
      total,
      has_more: hasMore,
    };
    if (hasMore && page.length > 0) {
      out['next_before'] = page.at(-1)!.id;
    }
    return { output: artexEnvelopedJson('facts', out) };
  }
}
