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
import DESCRIPTION from './ingest_scan_output.md?raw';

const SCAN_FORMATS = ['nmap-xml', 'nuclei-jsonl', 'httpx-jsonl', 'ffuf-json'] as const;

export const IngestScanOutputInputSchema = z.object({
  format: z.enum(SCAN_FORMATS),
  path: z.string(),
});

export type IngestScanOutputInput = z.infer<typeof IngestScanOutputInputSchema>;

const PARAMETERS = toInputJsonSchema(IngestScanOutputInputSchema);

export const IArtexIngestScanOutputTool: ServiceIdentifier<AgentTool<IngestScanOutputInput>> =
  createDecorator<AgentTool<IngestScanOutputInput>>('artexIngestScanOutputTool');

export class ArtexIngestScanOutputTool implements AgentTool<IngestScanOutputInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ingest_scan_output' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(
    @IArtexSessionContext private readonly session: IArtexSessionContext,
    @IArtexGraphStoreProvider private readonly graphProvider: IArtexGraphStoreProvider,
    @IArtexWorkStoreProvider private readonly workProvider: IArtexWorkStoreProvider,
  ) {}

  resolveExecution(args: IngestScanOutputInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Ingesting ARTEX scan output (${args.format})`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: IngestScanOutputInput): Promise<ExecutableToolResult> {
    const handle = await openActiveGraph(this.session, this.graphProvider);
    if (handle === undefined) return ARTEX_INACTIVE_RESULT;
    const cwd = this.session.workspaceRoot;
    const absolute = resolve(cwd, args.path);
    const rel = relative(cwd, absolute);
    if (rel.startsWith('..')) return artexErr('path must stay within the working directory');
    const content = await readFile(absolute, 'utf8');
    const taskId = handle.explorationId;
    const work = this.workProvider.open(this.session.workspaceRoot);
    const assets: ArtexAssetInput[] = [];
    let facts = 0;
    if (args.format === 'httpx-jsonl') {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const row = JSON.parse(trimmed) as { url?: string };
          if (row.url === undefined) continue;
          assets.push({ type: 'service', url: row.url });
          facts += 1;
        } catch {
          continue;
        }
      }
    } else if (args.format === 'nuclei-jsonl') {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const row = JSON.parse(trimmed) as { host?: string; template_id?: string };
          if (row.host !== undefined) assets.push({ type: 'subdomain', domain: row.host });
          facts += 1;
        } catch {
          continue;
        }
      }
    } else {
      return artexErr(`format ${args.format} ingestion is not implemented in this build`);
    }
    let created = 0;
    for (const asset of assets) {
      const result = await work.upsertAsset(asset, taskId);
      if (result.created) created += 1;
    }
    return {
      output: artexJson({
        format: args.format,
        assets_written: created,
        facts_written: facts,
      }),
    };
  }
}