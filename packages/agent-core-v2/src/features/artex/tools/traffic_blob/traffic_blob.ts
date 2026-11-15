import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import { artexErr, artexRecordingInactive } from '../toolSupport';
import DESCRIPTION from './traffic_blob.md?raw';

const MAX_BLOB_READ = 8 * 1024;

export const TrafficBlobInputSchema = z.object({
  hash: z.string(),
  offset: z.number().int().optional(),
  length: z.number().int().optional(),
});

export type TrafficBlobInput = z.infer<typeof TrafficBlobInputSchema>;

const PARAMETERS = toInputJsonSchema(TrafficBlobInputSchema);

export const IArtexTrafficBlobTool: ServiceIdentifier<AgentTool<TrafficBlobInput>> =
  createDecorator<AgentTool<TrafficBlobInput>>('artexTrafficBlobTool');

export class ArtexTrafficBlobTool implements AgentTool<TrafficBlobInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'traffic_blob' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(@IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder) {}

  resolveExecution(args: TrafficBlobInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Reading ARTEX traffic blob ${args.hash.slice(0, 12)}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TrafficBlobInput): Promise<ExecutableToolResult> {
    const inactive = await artexRecordingInactive(this.recorder);
    if (inactive !== undefined) return inactive;
    const offset = args.offset !== undefined && args.offset > 0 ? args.offset : 0;
    const length =
      args.length === undefined || args.length <= 0 || args.length > MAX_BLOB_READ
        ? MAX_BLOB_READ
        : args.length;
    const range = await this.recorder.store().blobRange(args.hash, offset, length);
    if (range === undefined) return artexErr(`blob ${args.hash} does not exist`);
    if (range.data.length === 0) {
      return {
        output: `Offset ${String(offset)} is beyond the content length (total ${String(range.total)} bytes).`,
      };
    }
    const head = `[offset=${String(offset)} chunk=${String(range.data.length)} total=${String(range.total)}]\n`;
    if (isBinary(range.data)) {
      return {
        output: `${head}Binary content; first 512 bytes shown as hex:\n${range.data.subarray(0, 512).toString('hex')}`,
      };
    }
    return { output: head + range.data.toString('utf8') };
  }
}

function isBinary(data: Buffer): boolean {
  const sample = data.subarray(0, 512);
  return sample.includes(0);
}
