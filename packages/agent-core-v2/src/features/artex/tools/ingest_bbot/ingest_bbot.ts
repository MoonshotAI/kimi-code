import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

import { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import type { ArtexAssetInput } from '#/features/artex/store/artexWorkStore';

import { ARTEX_INACTIVE_RESULT, artexErr, artexJson, openActiveGraph } from '../toolSupport';
import DESCRIPTION from './ingest_bbot.md?raw';

export const IngestBbotInputSchema = z.object({
  path: z.string(),
});

export type IngestBbotInput = z.infer<typeof IngestBbotInputSchema>;

const PARAMETERS = toInputJsonSchema(IngestBbotInputSchema);

export const IArtexIngestBbotTool: ServiceIdentifier<AgentTool<IngestBbotInput>> =
  createDecorator<AgentTool<IngestBbotInput>>('artexIngestBbotTool');

export class ArtexIngestBbotTool implements AgentTool<IngestBbotInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ingest_bbot' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly graphProvider: IArtexGraphStoreProvider,
    @IArtexWorkStoreProvider private readonly workProvider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: IngestBbotInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: 'Ingesting BBOT output into ARTEX assets',
      execute: () => this.execute(args),
    };
  }

  private async execute(args: IngestBbotInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.graphProvider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const cwd = this.session.workspaceRoot;
    const absolute = resolve(cwd, args.path);
    const rel = relative(cwd, absolute);
    if (rel.startsWith('..')) return artexErr('path must stay within the working directory');
    const content = await readFile(absolute, 'utf8');
    const assets: ArtexAssetInput[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const row = JSON.parse(trimmed) as { type?: string; data?: Record<string, unknown> };
        const data = row.data;
        const host = typeof data?.['host'] === 'string' ? data['host'] : undefined;
        const url = typeof data?.['url'] === 'string' ? data['url'] : undefined;
        if (url !== undefined) assets.push({ type: 'service', url });
        else if (host !== undefined) assets.push({ type: 'subdomain', domain: host });
      } catch {
        continue;
      }
    }
    const work = this.workProvider.open(this.session.workspaceRoot);
    let created = 0;
    for (const asset of assets) {
      const result = await work.upsertAsset(asset, handle.explorationId);
      if (result.created) created += 1;
    }
    return {
      output: artexJson({ assets_written: created, events: assets.length }),
    };
  }
}