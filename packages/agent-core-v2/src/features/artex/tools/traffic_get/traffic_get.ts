import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import type {
  AgentTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

import { artexErr, artexRecordingInactive, clipText } from '../toolSupport';
import DESCRIPTION from './traffic_get.md?raw';

export const TrafficGetInputSchema = z.object({
  id: z.string(),
});

export type TrafficGetInput = z.infer<typeof TrafficGetInputSchema>;

const PARAMETERS = toInputJsonSchema(TrafficGetInputSchema);

export const IArtexTrafficGetTool: ServiceIdentifier<AgentTool<TrafficGetInput>> =
  createDecorator<AgentTool<TrafficGetInput>>('artexTrafficGetTool');

export class ArtexTrafficGetTool implements AgentTool<TrafficGetInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'traffic_get' as const;
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS;

  constructor(@IArtexTrafficRecorder private readonly recorder: IArtexTrafficRecorder) {}

  resolveExecution(args: TrafficGetInput): ToolExecution {
    return {
      approvalRule: this.name,
      description: `Reading ARTEX traffic record ${args.id}`,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TrafficGetInput): Promise<ExecutableToolResult> {
    const inactive = await artexRecordingInactive(this.recorder);
    if (inactive !== undefined) return inactive;
    const raw = await this.recorder.store().get(args.id);
    if (raw === undefined) return artexErr(`traffic ${args.id} does not exist`);
    return {
      output: `=== REQUEST ===\n${clipText(raw.request, 2500)}\n\n=== RESPONSE ===\n${clipText(raw.response, 4000)}`,
    };
  }
}
