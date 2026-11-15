import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import { artexErr, artexJson, artexRecordingInactive } from '../toolSupport';
import DESCRIPTION from './traffic_search.md?raw';

export const TrafficSearchInputSchema = z.object({
  host: z.string(),
  contains: z.string().optional(),
  body_contains: z.string().optional(),
  limit: z.number().int().optional(),
  page: z.number().int().optional(),
});

export type TrafficSearchInput = z.infer<typeof TrafficSearchInputSchema>;

const PARAMETERS = toInputJsonSchema(TrafficSearchInputSchema);

export const IArtexTrafficSearchTool: ServiceIdentifier<AgentTool<TrafficSearchInput>> =
  createDecorator<AgentTool<TrafficSearchInput>>('artexTrafficSearchTool');

export class ArtexTrafficSearchTool implements AgentTool<TrafficSearchInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'traffic_search' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(@IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder) {}

  resolveExecution(args: TrafficSearchInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Searching ARTEX traffic for ${args.host}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TrafficSearchInput): Promise<ExecutableToolResult> {
    const inactive = await artexRecordingInactive(this.recorder);
    if (inactive !== undefined) return inactive;
    if (args.host.trim() === '') {
      return artexErr(
        'host is a required parameter: specify a bare host, host:port, or full URL to avoid a full-database scan.',
      );
    }
    try {
      const rows = await this.recorder.store().search({
        host: args.host,
        contains: args.contains,
        bodyContains: args.body_contains,
        limit: args.limit,
        page: args.page,
      });
      if (rows.length === 0) return { output: 'No matching traffic.' };
      return {
        output: artexJson(
          rows.map((row) => ({
            id: row.id,
            method: row.method,
            url: row.url,
            status: row.status,
            resp_len: row.respLen,
          })),
        ),
      };
    } catch (error) {
      return artexErr(error instanceof Error ? error.message : String(error));
    }
  }
}
