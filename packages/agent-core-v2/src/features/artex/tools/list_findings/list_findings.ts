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
import DESCRIPTION from './list_findings.md?raw';

export const ListFindingsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export type ListFindingsInput = z.infer<typeof ListFindingsInputSchema>;

const PARAMETERS = toInputJsonSchema(ListFindingsInputSchema);

export const IArtexListFindingsTool: ServiceIdentifier<AgentTool<ListFindingsInput>> =
  createDecorator<AgentTool<ListFindingsInput>>('artexListFindingsTool');

export class ArtexListFindingsTool implements AgentTool<ListFindingsInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_findings' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly provider: IArtexGraphStoreProvider,
  ) {}

  resolveExecution(args: ListFindingsInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Listing ARTEX findings',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: ListFindingsInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.provider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const findings = await handle.store.listByKind('finding', args.limit);
    const rows = findings.map((node) => {
      const payload = node.payload as Record<string, unknown>;
      return {
        node_id: node.id,
        state: node.state,
        vulnclass: payload['vulnclass'],
        name: payload['name'],
        severity: payload['severity'],
        summary: payload['summary'],
        asset_ids: payload['asset_ids'] ?? [],
        evidence_status: payload['evidence_status'],
      };
    });
    return { output: artexEnvelopedJson('findings', rows) };
  }
}
