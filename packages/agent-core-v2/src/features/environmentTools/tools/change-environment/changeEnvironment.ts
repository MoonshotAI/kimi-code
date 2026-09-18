import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const ChangeEnvironmentInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      'Environment id to switch to: "local" for this machine, or one of the environment ids listed in the available environments section.',
    ),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Working directory on the target environment. Required for remote environments whose declaration does not set defaultCwd; optional for "local".',
    ),
});

export type ChangeEnvironmentInput = z.infer<typeof ChangeEnvironmentInputSchema>;

export interface IChangeEnvironmentTool extends AgentTool<ChangeEnvironmentInput> {
  readonly _serviceBrand: undefined;
}

export const IChangeEnvironmentTool =
  createDecorator<IChangeEnvironmentTool>('changeEnvironmentTool');
