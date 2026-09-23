import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

const connectIdSchema = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe(
    'Optional id for the new environment (at most 64 characters; "local" and "default" are reserved). Generated from the launcher when omitted.',
  );

export const ConnectEnvironmentInputSchema = z.union([
  z
    .object({
      type: z.literal('ssh'),
      host: z.string().min(1).describe('SSH host; user, key, and proxy resolve via ~/.ssh/config'),
      remoteBin: z
        .string()
        .min(1)
        .optional()
        .describe('Executor path on the target (default ~/.kimi-code/bin/kimi)'),
      id: connectIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('docker'),
      container: z.string().min(1).describe('Running container to docker exec into'),
      context: z.string().min(1).optional().describe('Optional docker context'),
      remoteBin: z
        .string()
        .min(1)
        .optional()
        .describe('Executor path in the container (default ~/.kimi-code/bin/kimi)'),
      id: connectIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('command'),
      command: z.string().min(1).describe('Launcher executable name or absolute path'),
      args: z.array(z.string()).optional().describe('Launcher arguments'),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe('Environment for the launcher process only'),
      id: connectIdSchema,
    })
    .strict(),
]);

export type ConnectEnvironmentInput = z.infer<typeof ConnectEnvironmentInputSchema>;

export interface IConnectEnvironmentTool extends AgentTool<ConnectEnvironmentInput> {
  readonly _serviceBrand: undefined;
}

export const IConnectEnvironmentTool =
  createDecorator<IConnectEnvironmentTool>('connectEnvironmentTool');
