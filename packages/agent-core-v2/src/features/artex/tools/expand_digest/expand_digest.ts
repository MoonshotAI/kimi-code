import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './expand_digest.md?raw';

export const ExpandDigestInputSchema = z.object({
  id: z.number().int(),
});

export type ExpandDigestInput = z.infer<typeof ExpandDigestInputSchema>;

const PARAMETERS = toInputJsonSchema(ExpandDigestInputSchema);

export const IArtexExpandDigestTool: ServiceIdentifier<AgentTool<ExpandDigestInput>> =
  createDecorator<AgentTool<ExpandDigestInput>>('artexExpandDigestTool');

export class ArtexExpandDigestTool implements AgentTool<ExpandDigestInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'expand_digest' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: ExpandDigestInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Expanding ARTEX digest ${String(args.id)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ExpandDigestInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const { store } = handle;
    const digest = await store.getNode(args.id);
    if (digest === undefined || digest.kind !== 'digest') {
      return artexErr(`#${String(args.id)} is not a digest node`);
    }

    const memberIds = await store.digestMembers(args.id);
    const members = await Promise.all(
      memberIds.map(async (memberId) => {
        const node = await store.getNode(memberId);
        if (node === undefined) {
          return { id: memberId, missing: true };
        }
        const payload = node.payload as {
          summary?: unknown;
          text?: unknown;
          confidence?: unknown;
        };
        const summary =
          typeof payload.summary === 'string' && payload.summary.trim().length > 0
            ? payload.summary.trim()
            : typeof payload.text === 'string'
              ? payload.text.trim()
              : '';
        const entry: Record<string, unknown> = {
          id: node.id,
          kind: node.kind,
          state: node.state,
          summary,
        };
        if (typeof payload.confidence === 'string' && payload.confidence !== '') {
          entry['confidence'] = payload.confidence;
        }
        return entry;
      }),
    );

    const body = (digest.payload as { body?: unknown }).body;
    return {
      output: artexJson({
        id: args.id,
        state: digest.state,
        body: typeof body === 'string' ? body : '',
        members,
      }),
    };
  }
}
